import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkAccessibility } from '../test/axe.ts';
import HomePage from './page.tsx';

describe('HomePage', () => {
  it('has no automatically detectable WCAG 2.2 AA violations', async () => {
    const { container } = render(<HomePage />);
    await checkAccessibility(container);
  });

  it('has exactly one h1, so the document outline starts unambiguously', () => {
    render(<HomePage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('links to the live engine test page', () => {
    render(<HomePage />);
    const link = screen.getByRole('link', { name: /try the engine test page/i });
    expect(link.getAttribute('href')).toBe('/try');
  });
});
