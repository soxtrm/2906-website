export function ListingCardSkeleton({ count = 6 }: { count?: number }) {
  return Array.from({ length: count }, (_, index) => (
    <div className="crm-listing-skeleton" aria-hidden="true" key={index}>
      <div className="crm-skeleton-photo crm-skeleton-fill" />
      <div className="crm-skeleton-copy">
        <div className="crm-skeleton-line crm-skeleton-line-title crm-skeleton-fill" />
        <div className="crm-skeleton-line crm-skeleton-line-meta crm-skeleton-fill" />
        <div className="crm-skeleton-line crm-skeleton-line-short crm-skeleton-fill" />
      </div>
      <div className="crm-skeleton-actions">
        <span className="crm-skeleton-fill" />
        <span className="crm-skeleton-fill" />
        <span className="crm-skeleton-fill" />
        <span className="crm-skeleton-fill" />
      </div>
    </div>
  ))
}
