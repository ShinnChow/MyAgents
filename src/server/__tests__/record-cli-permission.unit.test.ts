import { describe, expect, it } from 'vitest';

import { isAutoAllowedRecordCliCommand } from '../agent-session';

describe('Record CLI automatic permission', () => {
  it.each([
    'myagents record list',
    'myagents record list --kind text --tag meeting-1 --limit 25 --json',
    'myagents record list --json --kind audio',
    'myagents thought list --tag legacy --limit 10 --json',
    "myagents record create 'remember $(literal) and `literal`'",
    "myagents record create --content 'multi word literal'",
    'myagents record create --content-file /tmp/record.txt',
    "myagents thought create 'legacy literal'",
    'myagents thought create --content-file C:\\Temp\\record.txt',
  ])('allows the bounded literal form: %s', command => {
    expect(isAutoAllowedRecordCliCommand(command)).toBe(true);
  });

  it.each([
    "myagents record list --query '$(touch /tmp/pwn)'",
    'myagents record list --kind video',
    'myagents thought list --kind audio',
    'myagents record create "$(touch /tmp/pwn)"',
    'myagents record create --content "$(touch /tmp/pwn)"',
    "myagents record create 'safe' extra",
    "myagents record create 'safe'; touch /tmp/pwn",
    "myagents record create 'safe' && touch /tmp/pwn",
    'myagents record create --content-file /tmp/record.txt;touch',
    "myagents record create --content-file '/tmp/record.txt'",
    "myagents record list\nrm -rf /tmp/pwn",
  ])('requires normal permission handling for: %s', command => {
    expect(isAutoAllowedRecordCliCommand(command)).toBe(false);
  });
});
