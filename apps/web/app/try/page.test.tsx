import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkAccessibility } from '../../test/axe.ts';
import TryPage from './page.tsx';

describe('TryPage', () => {
  it('has no automatically detectable WCAG 2.2 AA violations', async () => {
    const { container } = render(<TryPage />);
    await checkAccessibility(container);
  });

  it('labels every form control', () => {
    render(<TryPage />);
    expect(screen.getByLabelText(/lease text/i)).toBeInstanceOf(HTMLTextAreaElement);
    expect(screen.getByLabelText(/a file/i)).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText(/jurisdiction/i)).toBeInstanceOf(HTMLSelectElement);
  });

  it('reports progress through a live region rather than a silent state change', () => {
    render(<TryPage />);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
