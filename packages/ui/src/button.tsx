import type { ButtonHTMLAttributes } from "react";

export function Button({
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white ${className ?? ""}`}
      type={type}
      {...props}
    />
  );
}
