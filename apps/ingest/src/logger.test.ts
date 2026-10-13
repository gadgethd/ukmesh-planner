import { describe, expect, it } from 'vitest';
import { redactUrl } from './logger.js';

describe('redactUrl', () => {
  it('strips userinfo entirely', () => {
    expect(redactUrl('postgres://user:pw@host:5432/db')).toBe('postgres://host:5432/db');
    expect(redactUrl('postgres://host:5432/db')).toBe('postgres://host:5432/db');
    expect(redactUrl('postgres://u@h/db')).toBe('postgres://h/db');
  });
});
