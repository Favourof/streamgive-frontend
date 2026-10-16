import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { APP_URL } from '@/lib/config';

import { EmbedSnippet } from './EmbedSnippet';

const NGO_ID = 'ngo-123';

vi.mock('@/components/toast/ToastProvider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

describe('EmbedSnippet', () => {
  it('renders an iframe snippet using the browser origin and the given NGO id', () => {
    render(<EmbedSnippet ngoId={NGO_ID} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    const expectedSrc = `${window.location.origin}/embed/${NGO_ID}`;

    expect(textarea.value).toContain(`src="${expectedSrc}"`);
    expect(textarea.value).toMatch(/^<iframe .*<\/iframe>$/);
  });

  it('falls back to APP_URL for the origin when server-rendered', () => {
    // renderToString has no `window`, so useSyncExternalStore reads its
    // getServerSnapshot argument (APP_URL) instead of window.location.origin.
    const html = renderToString(<EmbedSnippet ngoId={NGO_ID} />);

    expect(html).toContain(`src=&quot;${APP_URL}/embed/${NGO_ID}&quot;`);
  });

  it('renders an iframe preview next to the snippet using the selected width and height', () => {
    render(<EmbedSnippet ngoId={NGO_ID} />);

    const preview = screen.getByTitle('Donate widget preview') as HTMLIFrameElement;
    expect(preview).toBeInTheDocument();
    expect(preview.getAttribute('src')).toBe(`${window.location.origin}/embed/${NGO_ID}`);
    expect(preview).toHaveAttribute('width', '400');
    expect(preview).toHaveAttribute('height', '600');
  });

  it('updates the preview dimensions when changing size preset', async () => {
    const user = userEvent.setup();
    render(<EmbedSnippet ngoId={NGO_ID} />);

    const preview = screen.getByTitle('Donate widget preview');
    expect(preview).toHaveAttribute('width', '400');
    expect(preview).toHaveAttribute('height', '600');

    const select = screen.getByRole('combobox', { name: /size/i });
    await user.selectOptions(select, 'compact');

    expect(preview).toHaveAttribute('width', '300');
    expect(preview).toHaveAttribute('height', '500');

    await user.selectOptions(select, 'wide');

    expect(preview).toHaveAttribute('width', '600');
    expect(preview).toHaveAttribute('height', '400');
  });

  it('updates the preview dimensions when entering custom width and height', async () => {
    const user = userEvent.setup();
    render(<EmbedSnippet ngoId={NGO_ID} />);

    const preview = screen.getByTitle('Donate widget preview');
    const select = screen.getByRole('combobox', { name: /size/i });

    await user.selectOptions(select, 'custom');

    const widthInput = screen.getByRole('spinbutton', { name: /width/i });
    const heightInput = screen.getByRole('spinbutton', { name: /height/i });

    await user.clear(widthInput);
    await user.type(widthInput, '450');
    await user.clear(heightInput);
    await user.type(heightInput, '750');

    expect(preview).toHaveAttribute('width', '450');
    expect(preview).toHaveAttribute('height', '750');
  });
});

