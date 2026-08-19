import { describe, it, expect } from 'vitest';
import { parseDataUrl, imageUrlToSource, sourceToImageUrl } from '../src/utils/image-block.js';

describe('image-block helpers', () => {
  describe('parseDataUrl', () => {
    it('parses a base64 data: URI into media_type + data', () => {
      expect(parseDataUrl('data:image/png;base64,iVBORw0KGgo=')).toEqual({
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
      });
    });

    it('returns null for an http URL', () => {
      expect(parseDataUrl('https://example.com/cat.png')).toBeNull();
    });

    it('returns null for a non-base64 data: URI', () => {
      expect(parseDataUrl('data:text/plain,hello')).toBeNull();
    });
  });

  describe('imageUrlToSource', () => {
    it('converts a data: base64 URI to a base64 source', () => {
      expect(imageUrlToSource('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
        type: 'base64',
        media_type: 'image/jpeg',
        data: '/9j/4AAQ',
      });
    });

    it('converts an http URL to a url source (no download)', () => {
      expect(imageUrlToSource('https://example.com/cat.png')).toEqual({
        type: 'url',
        url: 'https://example.com/cat.png',
      });
    });
  });

  describe('sourceToImageUrl', () => {
    it('synthesizes a data: URI from a base64 source', () => {
      expect(
        sourceToImageUrl({ type: 'base64', media_type: 'image/png', data: 'iVBOR' }),
      ).toBe('data:image/png;base64,iVBOR');
    });

    it('passes a url source through unchanged', () => {
      expect(
        sourceToImageUrl({ type: 'url', url: 'https://example.com/cat.png' }),
      ).toBe('https://example.com/cat.png');
    });
  });

  describe('round-trip', () => {
    it('base64 source → image_url → base64 source is identity', () => {
      const src = { type: 'base64' as const, media_type: 'image/png', data: 'iVBORw0KGgo=' };
      expect(imageUrlToSource(sourceToImageUrl(src))).toEqual(src);
    });

    it('url source → image_url → url source is identity', () => {
      const src = { type: 'url' as const, url: 'https://example.com/cat.png' };
      expect(imageUrlToSource(sourceToImageUrl(src))).toEqual(src);
    });
  });
});
