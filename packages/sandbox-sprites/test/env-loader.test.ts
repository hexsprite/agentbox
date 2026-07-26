import { describe, expect, it } from 'vitest';
import { parseEnvFile, SPRITES_KEYS } from '../src/env-loader.js';

describe('parseEnvFile', () => {
  it('parses plain KEY=value', () => {
    expect(parseEnvFile('SPRITES_TOKEN=abc123')).toEqual({ SPRITES_TOKEN: 'abc123' });
  });

  it('strips surrounding double and single quotes', () => {
    expect(parseEnvFile('A="x y"\nB=\'z\'')).toEqual({ A: 'x y', B: 'z' });
  });

  it('honours the `export ` prefix', () => {
    expect(parseEnvFile('export SPRITES_ORG=jordan-baker')).toEqual({
      SPRITES_ORG: 'jordan-baker',
    });
  });

  it('skips blank lines and comments', () => {
    expect(parseEnvFile('\n# a comment\nA=1\n\n  # indented\nB=2\n')).toEqual({ A: '1', B: '2' });
  });

  it('skips lines with no `=` and lines starting with `=`', () => {
    expect(parseEnvFile('nonsense\n=novalue\nC=3')).toEqual({ C: '3' });
  });

  it('keeps `=` inside the value', () => {
    expect(parseEnvFile('T=a=b=c')).toEqual({ T: 'a=b=c' });
  });

  it('handles CRLF line endings', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('takes the last value when a key repeats', () => {
    expect(parseEnvFile('A=1\nA=2')).toEqual({ A: '2' });
  });
});

describe('SPRITES_KEYS', () => {
  it('imports exactly the token, org and API URL', () => {
    expect([...SPRITES_KEYS]).toEqual(['SPRITES_TOKEN', 'SPRITES_ORG', 'SPRITES_API_URL']);
  });
});
