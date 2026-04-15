export function getChartTheme(resolvedTheme: "dark" | "light") {
  if (resolvedTheme === "light") {
    return {
      grid: "hsl(220, 13%, 87%)",
      axis: "hsl(220, 8%, 46%)",
      tooltipBg: "hsl(0, 0%, 100%)",
      tooltipBorder: "hsl(220, 13%, 87%)",
    };
  }
  return {
    grid: "hsl(240, 6%, 20%)",
    axis: "hsl(220, 8%, 50%)",
    tooltipBg: "hsl(240, 8%, 9%)",
    tooltipBorder: "hsl(240, 6%, 20%)",
  };
}
