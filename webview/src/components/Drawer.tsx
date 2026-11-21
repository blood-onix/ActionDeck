import React, { useEffect, useRef } from "react";
import { Button } from "./Button";

export type DrawerKind =
  | "inspector"
  | "companion"
  | "batch"
  | "plan_editor"
  | "action_center"
  | "settings";

export interface DrawerProps {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  banner?: React.ReactNode;
  footer?: React.ReactNode;
  widthPx?: number | undefined;
  dockedPosition?: "side" | "bottom" | undefined;
  onWidthChange?: ((widthPx: number) => void) | undefined;
  onClose: () => void;
  className?: string | undefined;
  ariaLabel?: string | undefined;
  children?: React.ReactNode;
}

const MIN_DRAWER_WIDTH = 360;

export function Drawer({
  title,
  subtitle,
  actions,
  banner,
  footer,
  widthPx = 480,
  dockedPosition = "side",
  onWidthChange,
  onClose,
  className,
  ariaLabel,
  children,
}: DrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);

  const clampedWidth = Math.max(MIN_DRAWER_WIDTH, widthPx);

  useEffect(() => {
    if (!onWidthChange) return;
    const handleMouseMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      const nextWidth = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - event.clientX);
      onWidthChange(nextWidth);
    };
    const handleMouseUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [onWidthChange]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    if (event.defaultPrevented) return;

    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      if (active.closest('[role="dialog"][aria-modal="true"]')) {
        return;
      }
      if (
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
        active.value.length > 0
      ) {
        return;
      }
    }

    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  return (
    <>
      {dockedPosition === "side" && onWidthChange ? (
        <div
          className="ad-drawer-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          aria-valuemin={MIN_DRAWER_WIDTH}
          aria-valuenow={clampedWidth}
          tabIndex={0}
          onMouseDown={(event) => {
            event.preventDefault();
            draggingRef.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onWidthChange(clampedWidth + 24);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              onWidthChange(Math.max(MIN_DRAWER_WIDTH, clampedWidth - 24));
            }
          }}
        />
      ) : null}

      <aside
        ref={drawerRef}
        className={[
          "ad-drawer",
          dockedPosition === "bottom" ? "ad-drawer--bottom" : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={dockedPosition === "side" ? { width: `${clampedWidth}px` } : undefined}
        aria-label={ariaLabel ?? title}
        onKeyDown={handleKeyDown}
      >
        <header className="ad-drawer__head">
          <div className="ad-drawer__titles">
            <div className="ad-drawer__title" title={title}>
              {title}
            </div>
            {subtitle ? <div className="ad-drawer__sub">{subtitle}</div> : null}
          </div>
          <div className="ad-drawer__actions">
            {actions}
            <Button
              variant="ghost"
              icon="close"
              title="Close (Esc)"
              aria-label="Close"
              onClick={onClose}
            />
          </div>
        </header>

        {banner ? banner : null}

        <div className="ad-drawer__body">{children}</div>

        {footer ? <footer className="ad-drawer__foot">{footer}</footer> : null}
      </aside>
    </>
  );
}
