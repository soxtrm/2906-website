interface SeoIntroProps {
  heading: string
  body: string
  resultCount?: number
}

export function SeoIntro({ heading, body, resultCount }: SeoIntroProps) {
  return (
    <div className="max-w-3xl">
      <h1 className="font-serif text-3xl md:text-4xl lg:text-5xl text-white mb-3">{heading}</h1>
      <p className="text-white/70 text-sm md:text-base leading-relaxed">{body}</p>
      {typeof resultCount === 'number' && (
        <p className="text-white/50 text-xs mt-3">
          {resultCount} {resultCount === 1 ? 'active listing' : 'active listings'}
        </p>
      )}
    </div>
  )
}
