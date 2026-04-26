export const metadata = { title: '2906 Admin' }

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#0f1623] text-white min-h-screen antialiased">
        {children}
      </body>
    </html>
  )
}
