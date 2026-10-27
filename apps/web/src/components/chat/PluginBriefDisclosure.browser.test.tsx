import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PluginBriefHero, SentPluginBriefDisclosure } from "./PluginBriefDisclosure";

const brief = {
  pluginName: "Project Coordinator",
  text: "Coordinate Shelf.\n\nKeep this exact line.\n  Preserve indentation.",
};

it("lets a person inspect the brief before sending while keeping the project fixed", async () => {
  await using screen = await render(<PluginBriefHero projectName="Shelf" brief={brief} />);
  await vi.waitFor(() =>
    expect(screen.getByRole("heading", { level: 1 }).element().textContent).toContain("Shelf"),
  );
  await expect
    .element(screen.getByText("Project Coordinator adds its brief to your first message"))
    .toBeVisible();
  await expect.element(screen.getByRole("combobox")).not.toBeInTheDocument();
  expect(screen.container.querySelector("pre")).toBeNull();

  await screen.getByRole("button", { name: "View", exact: true }).click();
  await expect.element(screen.getByText("Added by Project Coordinator")).toBeVisible();
  await vi.waitFor(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe(brief.text),
  );
  await screen.getByRole("button", { name: "Hide", exact: true }).click();
  await vi.waitFor(() => expect(screen.container.querySelector("pre")).toBeNull());
});

it("discloses the exact sent snapshot with keyboard access without changing the user's text", async () => {
  await using screen = await render(
    <div>
      <p>Build a command menu</p>
      <SentPluginBriefDisclosure brief={brief} />
    </div>,
  );
  const disclosure = screen.getByRole("button", { name: "Includes Project Coordinator's brief" });
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
  disclosure.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe(brief.text),
  );
  await expect.element(screen.getByText("Build a command menu", { exact: true })).toBeVisible();
  await userEvent.keyboard(" ");
  await expect.element(disclosure).toHaveAttribute("aria-expanded", "false");
  await vi.waitFor(() => expect(screen.container.querySelector("pre")).toBeNull());
});
