import type { ComponentType, HTMLAttributes, ReactNode, SVGProps } from "react";

import { cn } from "@/lib/utils";
import "@/styles/workspace-page.css";

type WorkspaceIcon = ComponentType<SVGProps<SVGSVGElement>>;

interface WorkspacePageProps extends HTMLAttributes<HTMLDivElement> {
  layout?: "document" | "canvas";
}

interface WorkspaceHeaderProps extends HTMLAttributes<HTMLElement> {
  icon: WorkspaceIcon;
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

interface WorkspaceBodyProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  scroll?: boolean;
}

export function WorkspacePage({
  layout = "document",
  className,
  children,
  ...props
}: WorkspacePageProps) {
  return (
    <div
      className={cn("workspace-page", `workspace-page--${layout}`, className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function WorkspaceHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
  className,
  ...props
}: WorkspaceHeaderProps) {
  return (
    <header className={cn("workspace-page__header", className)} {...props}>
      <div className="workspace-page__identity">
        <span className="workspace-page__icon" aria-hidden="true">
          <Icon />
        </span>
        <div className="workspace-page__titles">
          <p className="workspace-page__eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {description ? <p className="workspace-page__description">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="workspace-page__actions">{actions}</div> : null}
    </header>
  );
}

export function WorkspaceBody({
  padded = true,
  scroll = false,
  className,
  children,
  ...props
}: WorkspaceBodyProps) {
  return (
    <div
      className={cn(
        "workspace-page__body",
        padded && "workspace-page__body--padded",
        scroll && "workspace-page__body--scroll",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
