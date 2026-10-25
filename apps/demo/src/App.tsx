import { useEffect, useState } from 'react';
import scanSampleUrl from '../../../packages/editor/test/fixtures/scan-invoice.pdf?url';
import { Home, type OpenRequest } from './Home';
import { createSamplePdf } from './sample-pdf';
import { Workspace } from './Workspace';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be blocked; follow the system then.
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [open, setOpen] = useState<OpenRequest | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // Not remembered; fine.
    }
  }, [theme]);

  // The browser's back button returns to the start page.
  useEffect(() => {
    const onPop = () => setOpen(null);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const show = (request: OpenRequest) => {
    history.pushState({ editing: true }, '');
    setOpen(request);
  };

  const sample = async (kind: 'contract' | 'scan') => {
    if (kind === 'contract') {
      const bytes = await createSamplePdf();
      show({ file: new File([bytes as BlobPart], 'Services agreement.pdf', { type: 'application/pdf' }), tool: 'editText' });
    } else {
      const bytes = await (await fetch(scanSampleUrl)).arrayBuffer();
      show({ file: new File([bytes], 'Scanned invoice.pdf', { type: 'application/pdf' }), tool: 'editText' });
    }
  };

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return open ? (
    <Workspace
      key={`${open.file.name}-${open.file.lastModified}`}
      file={open.file}
      tool={open.tool}
      recognize={open.recognize}
      pages={open.pages}
      sign={open.sign}
      theme={theme}
      onToggleTheme={toggleTheme}
      onClose={() => history.back()}
    />
  ) : (
    <Home onOpen={show} onSample={(kind) => void sample(kind)} theme={theme} onToggleTheme={toggleTheme} />
  );
}
