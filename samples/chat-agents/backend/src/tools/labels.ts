/**
 * Short human labels for the sample's tools.
 *
 * Used by the run's progress line, which has to name what it is waiting on in
 * words a person recognises — "Running a command" reads, `run_command` does not.
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  read_file: 'reading a file',
  list_directory: 'listing files',
  search_files: 'searching',
  propose_edit: 'preparing a diff',
  write_file: 'writing a file',
  edit_file: 'editing a file',
  delete_path: 'deleting',
  create_directory: 'creating a folder',
  move_path: 'moving a file',
  run_command: 'running a command',
  write_todos: 'updating the plan',
  fetch_url: 'fetching a page',
  wait_agents: 'waiting for another agent',
  send_message: 'messaging another agent',
  spawn_agent: 'starting another agent',
  close_agent: 'closing another agent',
  load_skill: 'loading a skill',
  read_tool_output: 'reading saved output',
}
