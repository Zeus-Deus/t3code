import { Pressable, ScrollView } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { usePluginTreeList } from "../plugins/usePluginTreeList";
import type { HomeHeaderProps } from "./HomeHeader.types";

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentId"
    | "selectedProjectKey"
    | "onEnvironmentChange"
    | "onProjectChange"
  > & {
    /** List padding the scroller bleeds through so pills start where row content does. */
    readonly gutter: number;
  },
) {
  const pluginTree = usePluginTreeList(
    props.environments.map((environment) => environment.environmentId),
  );
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      {pluginTree.options.length === 0 ? null : (
        <ListFilterMenu
          label={pluginTree.selected?.tree.title ?? "Activity"}
          accessibilityLabel="Choose how threads are arranged"
          active={pluginTree.selected !== null}
          actions={[
            {
              id: "activity",
              title: "Activity",
              state: pluginTree.selected === null ? "on" : "off",
            },
            ...pluginTree.options.map((option) => ({
              id: JSON.stringify(option.key),
              title: option.tree.title,
              state: pluginTree.selected?.key === option.key ? ("on" as const) : ("off" as const),
            })),
          ]}
          onSelect={(id) =>
            pluginTree.select(
              pluginTree.options.find((option) => JSON.stringify(option.key) === id) ?? null,
            )
          }
        />
      )}
      <ListFilterMenu
        label={selectedEnvironment?.label ?? "All environments"}
        accessibilityLabel="Filter threads by environment"
        active={selectedEnvironment !== undefined}
        actions={[
          {
            id: "all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state:
              environment.environmentId === props.selectedEnvironmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onEnvironmentChange(null);
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }
        }}
      />
      <ListFilterMenu
        label={selectedProject?.label ?? "All projects"}
        accessibilityLabel="Filter threads by project"
        active={selectedProject !== undefined}
        actions={[
          {
            id: "all",
            title: "All projects",
            state: props.selectedProjectKey === null ? "on" : "off",
          },
          ...props.projects.map((project) => ({
            id: JSON.stringify(project.key),
            title: project.label,
            state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onProjectChange(null);
          else {
            const project = props.projects.find(
              (candidate) => JSON.stringify(candidate.key) === id,
            );
            if (project) props.onProjectChange(project.key);
          }
        }}
      />
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            props.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
