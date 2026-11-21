export const workflowYamlFixtures = {
  workflowDispatch: "on:\n  workflow_dispatch:\n    inputs: {}\n",
  pushOnly: "on: [push]\n",
  reusableOnly: "on:\n  workflow_call:\n    inputs:\n      env:\n        type: string\n",
  reusableScalar: "on: workflow_call\n",
  reusableAndDispatch: "on:\n  workflow_call: {}\n  workflow_dispatch: {}\n",
  malformed: "on: [\n",
  annotatedFolder: "# @folder: Release/Deploy\nname: deploy\n",
  prefixed: "# a heading\nname: deploy\n",
  invalidAnnotation: "# @folder:\nname: deploy\n",
} as const;
