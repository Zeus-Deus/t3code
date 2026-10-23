import type { MenuAction } from "@react-native-menu/menu";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { usePluginTreeList } from "../plugins/usePluginTreeList";
import { ThreadListToolbar } from "./ThreadListToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
  const pluginTree = usePluginTreeList(
    props.environments.map((environment) => environment.environmentId),
  );
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const menuActions: MenuAction[] = [
      ...(pluginTree.options.length === 0
        ? []
        : ([
            {
              id: "view",
              title: "View",
              subactions: [
                {
                  id: "view:activity",
                  title: "Activity",
                  state: checkedMenuState(pluginTree.selected === null),
                },
                ...pluginTree.options.map((option) => ({
                  id: `view:${option.key}`,
                  title: option.tree.title,
                  subtitle: option.pluginName,
                  state: checkedMenuState(pluginTree.selected?.key === option.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),

    {
      id: "environment",
      title: "Environment",
      subactions: [
        {
          id: "environment:all",
          title: "All environments",
          state: checkedMenuState(props.selectedEnvironmentId === null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
        })),
      ],
    },
    ...(props.projects.length === 0
      ? []
      : ([
          {
            id: "project",
            title: "Project",
            subactions: [
              {
                id: "project:all",
                title: "All projects",
                state: checkedMenuState(props.selectedProjectKey === null),
              },
              ...props.projects.map((project) => ({
                id: `project:${project.key}`,
                title: project.label,
                state: checkedMenuState(props.selectedProjectKey === project.key),
              })),
            ],
          },
        ] satisfies MenuAction[])),
  ];
  const handleMenuAction = (event: { nativeEvent: { event: string } }) => {
    const id = event.nativeEvent.event;
      if (id === "view:activity") {
        pluginTree.select(null);
        return;
      }
      if (id.startsWith("view:")) {
        const option = pluginTree.options.find((candidate) => `view:${candidate.key}` === id);
        if (option) pluginTree.select(option);
        return;
      }

    if (id === "environment:all") {
      props.onEnvironmentChange(null);
      return;
    }

    if (id.startsWith("environment:")) {
      const environmentId = id.slice("environment:".length);
      const environment = props.environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (environment) {
        props.onEnvironmentChange(environment.environmentId);
      }
      return;
    }

    if (id === "project:all") {
      props.onProjectChange(null);
      return;
    }

    if (id.startsWith("project:")) {
      const projectKey = id.slice("project:".length);
      if (props.projects.some((project) => project.key === projectKey)) {
        props.onProjectChange(projectKey);
      }
      return;
    }
  };

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <ThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenEnvironments={props.onOpenEnvironments}
      />
    </>
  );
}
