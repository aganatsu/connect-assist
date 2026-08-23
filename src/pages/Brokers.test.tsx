import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionDetail } from "./Brokers";

describe("broker configuration actions", () => {
  it("disables auto-map under unknown trading truth while keeping broker reads available", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const props: ComponentProps<typeof ConnectionDetail> = {
      connection: {
        id: "broker-1",
        broker_type: "metaapi",
        display_name: "Demo",
        account_id: "account-1",
        is_live: false,
        is_active: true,
        symbol_suffix: "",
        symbol_overrides: {},
      },
      onTest: vi.fn(),
      onCheckStatus: vi.fn(),
      onAutoMap: vi.fn(),
      onListSymbols: vi.fn(),
      onConfigOpen: vi.fn(),
      onDelete: vi.fn(),
      isAutoMapping: false,
      isListing: false,
      isTesting: false,
      configurationMutationsEnabled: false,
    };

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectionDetail {...props} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: /auto-map symbols/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^test$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /status/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /browse symbols/i })).toBeEnabled();
  });
});
