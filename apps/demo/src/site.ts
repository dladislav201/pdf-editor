import type { OpenRequest } from './Home';

/**
 * The site's name and address, used in titles, canonical links, the sitemap
 * and structured data. Change them here once the product has its own name
 * and domain.
 */
export const SITE = {
  name: 'Private PDF Editor',
  url: 'https://pdf-sdk-demo.peer-mcp.workers.dev',
};

/** One page people can land on from a search: a tool with its own address and words. */
export interface Landing {
  path: string;
  /** Link text in the footer. */
  name: string;
  /** The page title: what people search for first. */
  title: string;
  description: string;
  h1: string;
  lead: string;
  /** What "Choose a PDF" does on this page. */
  open?: Omit<OpenRequest, 'file'>;
  /** The chooser takes pictures instead of PDFs. */
  pictures?: boolean;
  steps: [string, string, string];
  faq: { q: string; a: string }[];
}

const PRIVATE = {
  q: 'Are my files uploaded?',
  a: 'No. The PDF is opened, changed and saved in your browser, on your device. Nothing is sent to a server, so it works with confidential documents too.',
};
const FREE = {
  q: 'Is it free?',
  a: 'Yes, with no sign-up, no watermark and no limit on the number of files.',
};

export const LANDINGS: Landing[] = [
  {
    path: '/',
    name: 'Edit PDF',
    title: 'Edit PDF online, free and private',
    description:
      'Edit any PDF in your browser: change text, edit scans, sign, fill forms, compress and organize pages. Free, no sign-up, files never leave your device.',
    h1: 'Edit any PDF, right in your browser.',
    lead: 'Change text, fix scans, sign and mark up. Your files never leave your device.',
    steps: ['Choose a PDF or drop it on the page.', 'Pick a tool: edit text, sign, annotate, organize pages.', 'Download the edited PDF.'],
    faq: [
      PRIVATE,
      FREE,
      {
        q: 'Can I change the text that is already in the PDF?',
        a: 'Yes. Click a paragraph with Edit text and type: lines wrap as you write, in the document’s own fonts.',
      },
      {
        q: 'Does it work on a phone?',
        a: 'Yes, in any modern browser: Chrome, Safari, Edge and Firefox, on a computer or a phone.',
      },
    ],
  },
  {
    path: '/edit-pdf-text',
    name: 'Edit PDF text',
    title: 'Edit PDF text online, in the original font',
    description:
      'Change words, numbers and whole paragraphs in a PDF. Text wraps as you type and keeps the document’s fonts. Free, private, in your browser.',
    h1: 'Edit the text of a PDF.',
    lead: 'Click a paragraph and type. Lines wrap, alignment and fonts stay as they were.',
    open: { tool: 'editText' },
    steps: ['Choose the PDF.', 'Click the paragraph you want to change and type.', 'Download the PDF with the new text.'],
    faq: [
      {
        q: 'Will the edited text look like the rest?',
        a: 'It is set in the PDF’s own font. If that font lacks a letter you type, a matching open font fills in just that letter.',
      },
      {
        q: 'Can I still search and copy the text afterwards?',
        a: 'Yes. The new text is real text in the saved PDF, not a picture.',
      },
      PRIVATE,
    ],
  },
  {
    path: '/edit-scanned-pdf',
    name: 'Edit a scanned PDF',
    title: 'Edit a scanned PDF online, in the scan’s own letters',
    description:
      'Change text on a scanned PDF: the page is read with OCR, and your edits are set in letters cut from the scan itself, stamps and signatures kept. Free and private.',
    h1: 'Edit a scanned PDF.',
    lead: 'The scan is read, then your words are set in letters taken from the scan itself, so they blend in.',
    open: { tool: 'editText', recognize: true },
    steps: ['Choose the scanned PDF.', 'Click a line: its text is read first, then you can edit it.', 'Download the PDF.'],
    faq: [
      {
        q: 'How does editing a scan work?',
        a: 'The page is recognized (OCR) in your browser. When you change a line, it is redrawn from the scan’s own letters, on the scan’s slant, and the rest of the page stays untouched.',
      },
      {
        q: 'What about stamps and signatures?',
        a: 'They stay. Only the letters you change are redrawn; a stamp over them is kept.',
      },
      { q: 'Which languages are recognized?', a: 'English and Ukrainian.' },
      PRIVATE,
    ],
  },
  {
    path: '/ocr-pdf',
    name: 'OCR PDF',
    title: 'OCR PDF online: make a scanned PDF searchable',
    description:
      'Recognize the text of scanned PDF pages and add it as an invisible text layer, so you can search, select and copy it. Free OCR in your browser.',
    h1: 'Make a scanned PDF searchable.',
    lead: 'Text recognition adds an invisible layer of text under the scan: the page looks the same, but you can search and copy it.',
    open: { recognize: true },
    steps: ['Choose the scanned PDF.', 'Its pages are read in your browser.', 'Download a searchable PDF.'],
    faq: [
      {
        q: 'Does OCR change how the page looks?',
        a: 'No. The recognized text is invisible and sits under the scan, as in Acrobat’s Recognize text.',
      },
      { q: 'Which languages are recognized?', a: 'English and Ukrainian.' },
      PRIVATE,
    ],
  },
  {
    path: '/sign-pdf',
    name: 'Sign PDF',
    title: 'Sign PDF online: draw, type or upload your signature',
    description:
      'Add your signature to a PDF: draw it, type it in a handwriting font or upload a picture, then place, move and resize it. Free, private, no sign-up.',
    h1: 'Sign a PDF.',
    lead: 'Draw, type or upload your signature, then place it where it goes.',
    open: { sign: true },
    steps: ['Choose the PDF.', 'Draw, type or upload your signature.', 'Place it, resize it, and download.'],
    faq: [
      {
        q: 'Is my signature saved?',
        a: 'Only in your browser, so you can reuse it next time. It is never uploaded.',
      },
      {
        q: 'Is this a digital (certificate) signature?',
        a: 'No. It is a picture of your signature on the page, like signing a printout. Certificate signatures are not supported yet.',
      },
      FREE,
    ],
  },
  {
    path: '/fill-pdf-form',
    name: 'Fill PDF form',
    title: 'Fill PDF forms online',
    description:
      'Type into PDF form fields, tick check boxes, pick from lists and save the filled form. Works with any script. Free, private, in your browser.',
    h1: 'Fill in a PDF form.',
    lead: 'Type into the fields, tick the boxes, pick from the lists. Tab moves to the next field.',
    open: { tool: 'select' },
    steps: ['Choose the PDF form.', 'Fill in the fields.', 'Download the filled form.'],
    faq: [
      {
        q: 'Will the form still be editable after saving?',
        a: 'Yes. The values are saved in the form fields, so you or someone else can change them later.',
      },
      {
        q: 'My PDF has no fields. Can I still fill it?',
        a: 'Yes: use Note to type text anywhere on the page, or Sign to add a signature.',
      },
      PRIVATE,
    ],
  },
  {
    path: '/annotate-pdf',
    name: 'Annotate PDF',
    title: 'Annotate PDF online: highlight, draw, add notes',
    description:
      'Highlight text, draw, add shapes and notes to a PDF. Annotations stay editable in any PDF viewer. Free, private, in your browser.',
    h1: 'Highlight and annotate a PDF.',
    lead: 'Highlight, draw, add shapes and notes. They are saved as real PDF annotations.',
    open: { tool: 'highlight' },
    steps: ['Choose the PDF.', 'Highlight, draw or add a note.', 'Download the annotated PDF.'],
    faq: [
      {
        q: 'Can others see and change my annotations?',
        a: 'Yes. They are saved as standard PDF annotations, which other PDF viewers show and can edit.',
      },
      PRIVATE,
      FREE,
    ],
  },
  {
    path: '/compress-pdf',
    name: 'Compress PDF',
    title: 'Compress PDF online: make a PDF smaller for email',
    description:
      'Reduce the size of a PDF: scans and photos are made smaller while text stays sharp. Three levels, free, and your file never leaves your device.',
    h1: 'Compress a PDF.',
    lead: 'Make a PDF small enough for email: pictures and scans shrink, text and drawings stay sharp.',
    open: { dialog: 'compress' },
    steps: ['Choose the PDF.', 'Pick light, recommended or strong.', 'Download the smaller PDF.'],
    faq: [
      {
        q: 'Will the text get blurry?',
        a: 'No. Only pictures and scanned pages are made smaller; text and vector drawings are not touched.',
      },
      {
        q: 'How much smaller will it get?',
        a: 'It depends on the pictures in it. A scanned document often shrinks to a third of its size on Strong.',
      },
      PRIVATE,
    ],
  },
  {
    path: '/merge-pdf',
    name: 'Merge PDF',
    title: 'Merge PDF files online',
    description: 'Combine several PDFs into one and put the pages in the order you want. Free, private, no upload.',
    h1: 'Merge PDF files.',
    lead: 'Add pages from other PDFs, drag them into order, and save one file.',
    open: { pages: true },
    steps: ['Choose the first PDF.', 'Add the other PDFs and drag pages into order.', 'Apply and download.'],
    faq: [
      { q: 'Do links and annotations survive?', a: 'Yes, they travel with their pages.' },
      PRIVATE,
      FREE,
    ],
  },
  {
    path: '/split-pdf',
    name: 'Split PDF',
    title: 'Split PDF online: extract pages into a new PDF',
    description: 'Pick the pages you need and save them as a new PDF. Free, private, in your browser.',
    h1: 'Split a PDF.',
    lead: 'Select the pages you need and extract them into a new PDF.',
    open: { pages: true },
    steps: ['Choose the PDF.', 'Select pages (Shift-click for a range).', 'Extract them as a new PDF.'],
    faq: [{ q: 'Is the original file changed?', a: 'No. The extracted pages are saved as a new file.' }, PRIVATE, FREE],
  },
  {
    path: '/rotate-pdf',
    name: 'Rotate PDF',
    title: 'Rotate PDF pages online',
    description: 'Turn one page or the whole PDF left or right and save it. Free, private, in your browser.',
    h1: 'Rotate PDF pages.',
    lead: 'Turn single pages or all of them, then save the PDF the right way up.',
    open: { pages: true },
    steps: ['Choose the PDF.', 'Rotate the pages that need it.', 'Apply and download.'],
    faq: [PRIVATE, FREE],
  },
  {
    path: '/delete-pdf-pages',
    name: 'Delete PDF pages',
    title: 'Delete pages from a PDF online',
    description: 'Remove pages you don’t need from a PDF, reorder the rest and save. Free, private, in your browser.',
    h1: 'Delete pages from a PDF.',
    lead: 'Select the pages you don’t need, delete them, and save the rest.',
    open: { pages: true },
    steps: ['Choose the PDF.', 'Select the pages to remove and delete them.', 'Apply and download.'],
    faq: [PRIVATE, FREE],
  },
  {
    path: '/pdf-to-jpg',
    name: 'PDF to JPG',
    title: 'PDF to JPG or PNG online',
    description: 'Save every page of a PDF as a JPG or PNG picture at 72, 150 or 300 dpi. Several pages come as a ZIP. Free and private.',
    h1: 'Turn PDF pages into pictures.',
    lead: 'Every page as a JPG or PNG, edits and annotations included.',
    open: { dialog: 'images' },
    steps: ['Choose the PDF.', 'Pick JPG or PNG and a resolution.', 'Save the pictures (a ZIP for several pages).'],
    faq: [{ q: 'Which resolution should I pick?', a: '150 dpi for screens and email, 300 dpi for printing.' }, PRIVATE, FREE],
  },
  {
    path: '/jpg-to-pdf',
    name: 'JPG to PDF',
    title: 'JPG to PDF online: turn photos into a PDF',
    description: 'Turn JPG, PNG or WebP photos into one PDF, a page per picture, then edit or sign it. Free, private, in your browser.',
    h1: 'Turn photos into a PDF.',
    lead: 'Choose one or more pictures: each becomes a page of one PDF.',
    pictures: true,
    steps: ['Choose your JPG, PNG or WebP pictures.', 'Reorder the pages if needed.', 'Download the PDF.'],
    faq: [
      { q: 'Are the photos made smaller?', a: 'JPGs go into the PDF as they are, so nothing is lost. Use Compress afterwards for a smaller file.' },
      PRIVATE,
      FREE,
    ],
  },
];

export const landingFor = (path: string): Landing | undefined =>
  LANDINGS.find((page) => page.path === (path.replace(/\/+$/, '') || '/'));
