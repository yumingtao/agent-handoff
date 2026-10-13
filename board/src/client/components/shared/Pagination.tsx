import { Link } from 'react-router-dom';

export function Pagination({
  page,
  totalPages,
  totalTopics,
  buildURL,
}: {
  page: number;
  totalPages: number;
  totalTopics: number;
  buildURL: (p: number) => string;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <div className="pagination-info">
        Page {page} / {totalPages} &middot; {totalTopics} topics
      </div>
      <div className="pagination-actions">
        <Link
          className={`page-link${page === 1 ? ' page-link-disabled' : ''}`}
          to={buildURL(Math.max(1, page - 1))}
        >
          &lsaquo; Prev
        </Link>
        <Link
          className={`page-link${page === totalPages ? ' page-link-disabled' : ''}`}
          to={buildURL(Math.min(totalPages, page + 1))}
        >
          Next &rsaquo;
        </Link>
      </div>
    </div>
  );
}
