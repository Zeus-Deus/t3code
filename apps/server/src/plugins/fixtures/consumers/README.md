# Plugin consumer fixtures

These fixed artifacts exercise the public plugin API in real workers and the
view bridge in browser tests. They are test inputs, not application features,
bundled plugins or automatic installations.

Keep their runtime files self-contained: tests must not depend on a developer's
separate plugin repository or an installed snapshot. The tests beside
`PluginExamples`, `PluginRepositoryLens` and `PluginWorkflowExamples`, plus the
web view-bridge tests, cover these consumers.
