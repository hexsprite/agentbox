import { spawn } from 'node:child_process';
import { confirm, intro, log, outro } from '../lib/prompt.js';
import { DEFAULT_BOX_IMAGE } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { detectExecutionMethod, type ExecMethod } from '../exec-method.js';
import { handleLifecycleError } from './_errors.js';
import {
  NIGHTLY_DIST_TAG,
  NPM_PACKAGE,
  STABLE_DIST_TAG,
  persistChannel,
  resolveChannel,
  type UpdateChannel,
} from '../lib/channel.js';
import { runPostUpdateRefresh } from '../lib/post-update-refresh.js';
import { fetchNpmBest } from '../lib/update-check.js';
import { isNewer } from '../lib/semver-lite.js';
import { maybePromptStar } from '../lib/star-prompt.js';
import { AGENTBOX_VERSION } from '../version.js';

interface UpdateOptions {
  yes?: boolean;
  dryRun?: boolean;
  skipSelf?: boolean;
  skipSkills?: boolean;
  channel?: string;
}

/** The published npm package name (apps/cli/package.json `name`). */
const PKG = NPM_PACKAGE;

/**
 * What to install. On the nightly channel the newest build can live under either
 * dist-tag, so we install the resolved **version** rather than a tag — asking
 * for `@nightly` when the winner is a stable release would install an older
 * build, silently downgrading the tester.
 *
 * Falls back to the channel's own dist-tag when the registry couldn't be reached,
 * so an offline `self-update` still does the obvious thing.
 */
function selfUpdateCommand(
  method: ExecMethod,
  spec: string,
): { cmd: string; args: string[] } | null {
  if (method === 'npm') return { cmd: 'npm', args: ['install', '-g', `${PKG}@${spec}`] };
  if (method === 'pnpm') return { cmd: 'pnpm', args: ['add', '-g', `${PKG}@${spec}`] };
  return null;
}

function describeSelfUpdate(method: ExecMethod, spec: string): string {
  switch (method) {
    case 'npm':
      return `self-update: npm install -g ${PKG}@${spec}`;
    case 'pnpm':
      return `self-update: pnpm add -g ${PKG}@${spec}`;
    case 'npx':
      return 'self-update: skipped (running via npx — always the latest version)';
    case 'direct':
      return 'self-update: skipped (running from source — no global install to update)';
  }
}

function runInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', rejectP);
    child.on('close', (code) => resolveP(code ?? 0));
  });
}

/**
 * Best-effort current-vs-newest report; a dead network never blocks the update.
 * Returns the version to install, or undefined when the registry is unreachable.
 */
async function reportLatest(channel: UpdateChannel): Promise<string | undefined> {
  try {
    const latest = await fetchNpmBest(channel);
    if (latest === undefined) return undefined;
    const suffix = channel === 'nightly' ? ' [nightly channel]' : '';
    log.info(
      isNewer(latest, AGENTBOX_VERSION)
        ? `current ${AGENTBOX_VERSION} → newest ${latest}${suffix}`
        : `already the newest (${AGENTBOX_VERSION})${suffix} — refreshing skills/image/relay/app anyway`,
    );
    return latest;
  } catch {
    // Offline — proceed without the report.
    return undefined;
  }
}

export const updateCommand = new Command('self-update')
  .description(
    'Update agentbox: self-update via npm/pnpm (unless run via npx), refresh the host skills, re-check the box image (rebuilt on the next create only if its build context changed), reload the relay/hub, and update the menu-bar app',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "show what would happen, don't change anything")
  .option(
    '--skip-self',
    'skip the package self-update; only refresh the skills + image + relay + app',
  )
  .option(
    '--skip-skills',
    'skip refreshing the host skill files in ~/.claude, ~/.codex, ~/.config/opencode',
  )
  .option(
    '--channel <channel>',
    'switch release channel: `nightly` opts into pre-release builds, `stable` opts back out (persisted as update.channel)',
  )
  .action(async (opts: UpdateOptions) => {
    try {
      const method = detectExecutionMethod({
        userAgent: process.env.npm_config_user_agent,
        argv1: process.argv[1],
      });

      intro('agentbox self-update');

      if (opts.channel !== undefined && opts.channel !== 'stable' && opts.channel !== 'nightly') {
        throw new Error(`--channel must be \`stable\` or \`nightly\` (got "${opts.channel}")`);
      }
      const channel: UpdateChannel = opts.channel ?? (await resolveChannel());
      const newest = await reportLatest(channel);

      // Fall back to the channel's dist-tag when the registry was unreachable.
      const spec = newest ?? (channel === 'nightly' ? NIGHTLY_DIST_TAG : STABLE_DIST_TAG);

      const selfStep = opts.skipSelf
        ? 'self-update: skipped (--skip-self)'
        : describeSelfUpdate(method, spec);
      const skillsStep = opts.skipSkills
        ? 'skills: skipped (--skip-skills)'
        : 'skills: refresh agentbox-managed host skill files in ~/.claude (and Codex/OpenCode)';
      log.info(
        [
          'plan:',
          `  ${selfStep}`,
          `  ${skillsStep}`,
          `  image: docker image rm -f ${DEFAULT_BOX_IMAGE} (rebuilds on next create/claude)`,
          '  relay: stop, then respawn',
          '  app: update the menu-bar app if the published build changed (macOS, when installed)',
        ].join('\n'),
      );

      if (opts.dryRun) {
        outro('dry run — nothing changed');
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed with update?', initialValue: true });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      // Pin channel membership BEFORE installing. On nightly the newest build is
      // regularly a plain release, and once that is installed nothing in the
      // version string says "nightly" any more — without this record the next
      // launch derives `stable` and the tester is silently off the channel.
      // Written first so a failed/interrupted install can't lose the membership.
      if (opts.channel !== undefined || channel === 'nightly') {
        if (await persistChannel(channel)) {
          log.info(`channel: ${channel} (saved as update.channel)`);
        } else {
          log.warn(
            `could not save update.channel=${channel} — set it manually with \`agentbox config set update.channel ${channel} --global\``,
          );
        }
      }

      // Step 1: self-update. selfUpdated stays false unless an npm/pnpm global
      // install actually ran — that's what makes the running process stale.
      let selfUpdated = false;
      if (opts.skipSelf) {
        log.info('skipping self-update (--skip-self)');
      } else {
        const cmd = selfUpdateCommand(method, spec);
        if (cmd === null) {
          log.info(describeSelfUpdate(method, spec));
        } else {
          log.info(`running: ${cmd.cmd} ${cmd.args.join(' ')}`);
          const code = await runInherit(cmd.cmd, cmd.args);
          if (code !== 0) {
            throw new Error(`${cmd.cmd} exited with code ${String(code)}`);
          }
          selfUpdated = true;
          log.success(`updated ${PKG} via ${cmd.cmd}`);
        }
      }

      // Step 2: the post-update refresh (skills, image, relay, tray, version
      // stamp). After a real self-update this process is the old build — its
      // bundled skills are stale and respawning the relay would relaunch the
      // stale bin — so shell out to the freshly-installed binary, which also
      // stamps its own (new) version. Otherwise this process is already
      // current: run in-process.
      if (selfUpdated) {
        const args = ['_post-update-refresh', ...(opts.skipSkills ? ['--skip-skills'] : [])];
        const code = await runInherit('agentbox', args);
        if (code !== 0) {
          // Leave the stamp on the old version: the next run of the new
          // binary detects the mismatch and offers the refresh again.
          log.warn(
            `post-update refresh exited ${String(code)} — run \`agentbox self-update --skip-self\` to retry`,
          );
        }
      } else {
        await runPostUpdateRefresh({ skipSkills: opts.skipSkills });
      }

      await maybePromptStar({ trigger: 'self-update' });
      outro('update complete');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
