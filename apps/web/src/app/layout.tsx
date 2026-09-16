import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'The Banyan Grove | Guest Assistant',
  description:
    'Ask about the property, policies and amenities, or check live room availability, in one conversation.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The composer sits against the bottom edge, so the app needs the full
  // viewport including the area behind a phone home indicator.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#14110f' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
