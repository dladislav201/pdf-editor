import { useEffect, useState } from 'react';
import scanSampleUrl from '../../../packages/editor/test/fixtures/scan-invoice.pdf?url';
import { Home, type OpenRequest } from './Home';
import { imagesToPdf, type PageImage } from '@pdfsdk/editor';
import { createSampleForm } from './sample-form';
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

  const sample = async (kind: 'contract' | 'scan' | 'form') => {
    if (kind === 'form') {
      const bytes = await createSampleForm();
      show({ file: new File([bytes as BlobPart], 'Membership application.pdf', { type: 'application/pdf' }) });
    } else if (kind === 'contract') {
      const bytes = await createSamplePdf();
      show({ file: new File([bytes as BlobPart], 'Services agreement.pdf', { type: 'application/pdf' }), tool: 'editText' });
    } else {
      const bytes = await (await fetch(scanSampleUrl)).arrayBuffer();
      show({ file: new File([bytes], 'Scanned invoice.pdf', { type: 'application/pdf' }), tool: 'editText' });
    }
  };

  /** Photos become a PDF (one page each), opened for editing. WebP goes through a canvas to PNG. */
  const pictures = async (files: File[]) => {
    const images: PageImage[] = [];
    for (const file of files) {
      if (file.type === 'image/jpeg') images.push({ bytes: new Uint8Array(await file.arrayBuffer()), type: 'jpeg' });
      else if (file.type === 'image/png') images.push({ bytes: new Uint8Array(await file.arrayBuffer()), type: 'png' });
      else {
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png' });
      }
    }
    const bytes = await imagesToPdf(images);
    const name = files.length === 1 ? `${files[0]!.name.replace(/\.[^.]+$/, '')}.pdf` : 'Pictures.pdf';
    show({ file: new File([bytes as BlobPart], name, { type: 'application/pdf' }), pages: files.length > 1 });
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
      dialog={open.dialog}
      theme={theme}
      onToggleTheme={toggleTheme}
      onClose={() => history.back()}
    />
  ) : (
    <Home onOpen={show} onPictures={(files) => void pictures(files)} onSample={(kind) => void sample(kind)} theme={theme} onToggleTheme={toggleTheme} />
  );
}
