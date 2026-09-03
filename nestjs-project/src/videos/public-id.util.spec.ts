import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce 11 characters', () => {
    expect(generatePublicId()).toHaveLength(11);
  });

  it('should only use URL-safe characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not collide across 10,000 generations', () => {
    const generated = new Set<string>();

    for (let i = 0; i < 10_000; i++) {
      generated.add(generatePublicId());
    }

    expect(generated.size).toBe(10_000);
  });
});
