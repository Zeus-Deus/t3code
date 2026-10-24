import {
  EnvironmentId,
  type PluginCardReference,
  type PluginInstallation,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  cardReads: [] as unknown[],
  installations: [] as PluginInstallation[],
}));

const installation: PluginInstallation = {
  installationId: "inst-launcher",
  generation: "gen-1",
  manifest: {
    id: "examples.task-launcher",
    name: "Task launcher",
    version: "1.0.0",
    apiVersion: 1,
    entry: "plugin.mjs",
    capabilities: ["ui", "ui.conversation-cards"],
    actions: [],
    views: [{ id: "launcher", title: "Tasks", entry: "view.html", placement: "conversation" }],
    settings: [],
  },
  source: { kind: "local", directory: "/plugins/task-launcher" },
  digest: "a".repeat(64),
  enabled: true,
  consentedDigest: "a".repeat(64),
  status: "idle",
  error: null,
  settings: {},
  grants: { capabilities: ["ui", "ui.conversation-cards"], projectIds: [] },
  updatedAt: "2026-10-23T00:00:00.000Z",
};

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () =>
    ({
      serverConfig: {
        environment: { capabilities: { plugins: { apiVersion: 1, conversationCards: true } } },
      },
    }) as never,
}));
vi.mock(import("../../state/plugins"), async (original) => ({
  ...(await original()),
  usePluginCatalogue: () => ({
    availability: "available" as const,
    installations: state.installations,
    loaded: true,
    error: null,
  }),
  usePluginChangeRevision: () => null,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  const { pluginEnvironment } = await import("../../state/plugins");
  return {
    ...actual,
    useAtomCommand: ((command: { label: string }) => async (request: unknown) => {
      if (command.label === pluginEnvironment.readCardView.label) state.cardReads.push(request);
      return AsyncResult.success({ html: "<p>Plan</p>" });
    }) as never,
  };
});

import { PluginConversationCard } from "./PluginConversationCard";

function setup(installations: PluginInstallation[] = [installation]) {
  state.cardReads = [];
  state.installations = installations;
}

const card: PluginCardReference = {
  installationId: "inst-launcher",
  generation: "gen-1",
  dataOwner: "owner-1",
  viewId: "launcher",
  summary: "Launch plan: fix login",
  data: { planId: "plan-1" },
};

it("keeps a card's frame only while the row is near the viewport", async () => {
  setup();
  await using screen = await render(
    <div data-testid="scroller" style={{ height: 200, overflow: "auto" }}>
      <div style={{ height: 3000 }} />
      <PluginConversationCard
        environmentId={EnvironmentId.make("env-1")}
        threadRef={null}
        card={card}
      />
      <div style={{ height: 3000 }} />
    </div>,
  );
  const scroller = screen.container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
  const box = () => screen.container.querySelector("[data-plugin-card-frame]");
  const frames = () => screen.container.querySelectorAll("iframe").length;

  // Far below the fold: nothing is loaded for it.
  await vi.waitFor(() => expect(box()?.getAttribute("data-plugin-card-frame")).toBe("parked"));
  expect(frames()).toBe(0);
  expect(state.cardReads).toHaveLength(0);

  scroller.scrollTop = 2900;
  await vi.waitFor(() => expect(frames()).toBe(1));
  expect(state.cardReads).toHaveLength(1);

  // Scrolled away: the document goes, so it can no longer act or receive change signals.
  scroller.scrollTop = 0;
  await vi.waitFor(() => expect(frames()).toBe(0));
  expect(box()?.getAttribute("data-plugin-card-frame")).toBe("parked");
});

it("asks the reinstalled installation that kept the card's data for the recorded card", async () => {
  // Removed and reinstalled from the same source: a new installation that retained the data.
  setup([
    {
      ...installation,
      installationId: "inst-reinstalled",
      generation: "gen-7",
      dataOwner: "owner-1",
    },
  ]);
  await using screen = await render(
    <PluginConversationCard
      environmentId={EnvironmentId.make("env-1")}
      threadRef={null}
      card={card}
    />,
  );
  await vi.waitFor(() => expect(screen.container.querySelectorAll("iframe")).toHaveLength(1));
  expect(state.cardReads).toEqual([
    {
      environmentId: "env-1",
      input: { installationId: "inst-reinstalled", generation: "gen-7", card },
    },
  ]);
});

it("keeps the recorded summary when no installation here owns the card's data", async () => {
  // A fresh install after its data was deleted owns new data; the old card stays history.
  setup([{ ...installation, installationId: "inst-fresh", dataOwner: "inst-fresh" }]);
  await using screen = await render(
    <PluginConversationCard
      environmentId={EnvironmentId.make("env-1")}
      threadRef={null}
      card={card}
    />,
  );
  await expect
    .element(screen.getByText("This card’s original installation is unavailable here."))
    .toBeVisible();
  expect(screen.getByText("Launch plan: fix login")).toBeTruthy();
  expect(screen.container.querySelectorAll("iframe")).toHaveLength(0);
  expect(state.cardReads).toHaveLength(0);
});
