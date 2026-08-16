import React from 'react';
import './globals.css';

export const metadata = {
  title: 'AgriVoisin — Le frais tout près',
  description: 'La marketplace des jardins gourmands entre voisins.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
