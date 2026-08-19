import { describe, it, expect } from 'vitest';
import { generateApiKey, detectKeyMode } from '../src/services/api-key.js';

describe('generateApiKey', () => {
  it('should generate user mode key with correct prefix', () => {
    const key = generateApiKey('user');
    expect(key.plainText).toMatch(/^usr_sk_/);
    expect(key.prefix).toBe(key.plainText.substring(0, 12));
    expect(key.prefix).toMatch(/^usr_sk_/);
    expect(key.secret).toBe(key.plainText);
  });

  it('should generate app mode key with correct prefix', () => {
    const key = generateApiKey('app');
    expect(key.plainText).toMatch(/^app_sk_/);
    expect(key.prefix).toBe(key.plainText.substring(0, 12));
    expect(key.prefix).toMatch(/^app_sk_/);
    expect(key.secret).toBe(key.plainText);
  });

  it('should generate admin mode key with correct prefix', () => {
    const key = generateApiKey('admin');
    expect(key.plainText).toMatch(/^adm_sk_/);
    expect(key.prefix).toBe(key.plainText.substring(0, 12));
    expect(key.prefix).toMatch(/^adm_sk_/);
    expect(key.secret).toBe(key.plainText);
  });

  it('should produce key with 40-char random portion after prefix', () => {
    const key = generateApiKey('user');
    const randomPart = key.plainText.slice('usr_sk_'.length);
    expect(randomPart).toHaveLength(40);
    expect(randomPart).toMatch(/^[0-9a-f]+$/);
  });

  it('should store plaintext as secret', () => {
    const key = generateApiKey('user');
    expect(key.secret).toBe(key.plainText);
  });

  it('should produce unique keys on each call', () => {
    const key1 = generateApiKey('user');
    const key2 = generateApiKey('user');
    expect(key1.plainText).not.toBe(key2.plainText);
    expect(key1.secret).not.toBe(key2.secret);
  });
});

describe('detectKeyMode', () => {
  it('should detect user mode from usr_sk_ prefix', () => {
    expect(detectKeyMode('usr_sk_abc123def456')).toBe('user');
  });

  it('should detect app mode from app_sk_ prefix', () => {
    expect(detectKeyMode('app_sk_abc123def456')).toBe('app');
  });

  it('should detect admin mode from adm_sk_ prefix', () => {
    expect(detectKeyMode('adm_sk_abc123def456')).toBe('admin');
  });

  it('should return null for unknown prefix', () => {
    expect(detectKeyMode('sk_test_abc123')).toBeNull();
    expect(detectKeyMode('invalid_key')).toBeNull();
    expect(detectKeyMode('')).toBeNull();
  });
});

describe('key prefix extraction', () => {
  it('should extract 12-char prefix from generated user key', () => {
    const key = generateApiKey('user');
    expect(key.prefix).toHaveLength(12);
    expect(key.plainText.startsWith(key.prefix)).toBe(true);
  });

  it('should extract 12-char prefix from generated app key', () => {
    const key = generateApiKey('app');
    expect(key.prefix).toHaveLength(12);
    expect(key.plainText.startsWith(key.prefix)).toBe(true);
  });

  it('should extract 12-char prefix from generated admin key', () => {
    const key = generateApiKey('admin');
    expect(key.prefix).toHaveLength(12);
    expect(key.plainText.startsWith(key.prefix)).toBe(true);
  });
});
