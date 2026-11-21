import { Button } from "../components/Button";
import {
  autoHiddenColumns,
  COLUMN_LABELS,
  DEFAULT_COLUMN_LAYOUT,
  moveColumn,
  setColumnHidden,
  type ColumnLayout,
} from "../utils/columns";

/** Show, hide and reorder table columns. Headers can also be dragged to reorder and their edges dragged to resize. */
export function ColumnsMenu({
  layout,
  panelWidth,
  onChange,
  onClose,
}: {
  layout: ColumnLayout;
  panelWidth: number;
  onChange(layout: ColumnLayout): void;
  onClose(): void;
}) {
  const autoHidden = autoHiddenColumns(panelWidth);
  return (
    <section
      aria-label="Table columns"
      className="ad-card ad-popcard"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <strong>Columns</strong>
      <ul className="ad-colmenu">
        {layout.order.map((id, index) => {
          const label = COLUMN_LABELS[id];
          const visible = !layout.hidden.includes(id);
          return (
            <li key={id}>
              <label>
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(event) => onChange(setColumnHidden(layout, id, !event.target.checked))}
                />
                <span>{label}</span>
                {visible && autoHidden.has(id) ? (
                  <span className="ad-caption ad-muted">hidden while the panel is narrow</span>
                ) : null}
              </label>
              <Button
                variant="ghost"
                icon="arrow-up"
                title={`Move ${label} left`}
                disabled={index === 0}
                onClick={() => onChange(moveColumn(layout, id, index - 1))}
              />
              <Button
                variant="ghost"
                icon="arrow-down"
                title={`Move ${label} right`}
                disabled={index === layout.order.length - 1}
                onClick={() => onChange(moveColumn(layout, id, index + 1))}
              />
            </li>
          );
        })}
      </ul>
      <p className="ad-caption ad-muted">
        Workflow, selection and actions always show. Drag a header to reorder it; drag its right edge to resize,
        double-click the edge to reset.
      </p>
      <div className="ad-popcard__row">
        <Button variant="ghost" onClick={() => onChange(DEFAULT_COLUMN_LAYOUT)}>
          Reset columns
        </Button>
        <span className="ad-toolbar__spacer" />
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
