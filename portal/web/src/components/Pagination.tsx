import { CaretLeftIcon, CaretRightIcon } from '../icons';
import './library.css';

export function Pagination({ page, total, pageSize, onPageChange, label }: {
  page: number; total: number; pageSize: number; onPageChange: (page: number) => void; label: string;
}) {
  if (total <= pageSize) return null;
  const pages = Math.ceil(total / pageSize);
  const current = Math.max(0, Math.min(page, pages - 1));
  const start = current * pageSize + 1;
  const end = Math.min((current + 1) * pageSize, total);
  return <nav className="list-pagination" aria-label={`${label} pagination`}>
    <p role="status" aria-live="polite" aria-atomic="true">{start.toLocaleString()}{'\u2013'}{end.toLocaleString()} of {total.toLocaleString()}</p>
    {pages > 1 && <div className="pagination-actions">
      <button type="button" className="button secondary" aria-label={`Previous page of ${label}`} disabled={current === 0} onClick={() => onPageChange(current - 1)}><CaretLeftIcon size={18} aria-hidden="true" /><span>Previous</span></button>
      <span className="pagination-page">Page {current + 1} of {pages}</span>
      <button type="button" className="button secondary" aria-label={`Next page of ${label}`} disabled={current === pages - 1} onClick={() => onPageChange(current + 1)}><span>Next</span><CaretRightIcon size={18} aria-hidden="true" /></button>
    </div>}
  </nav>;
}
