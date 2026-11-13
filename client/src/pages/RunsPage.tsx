import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from "@ratchet/engine/constants";
import { useStartRuns } from "../hooks/mutations/useStartRuns";
import { useRuns } from "../hooks/queries/useRuns";
import { useWorkflows } from "../hooks/queries/useWorkflows";
import { Age } from "../components/Age";
import { Elapsed } from "../components/Elapsed";
import { StatusBadge } from "../components/StatusBadge";
import { FAILURE_REASON_LABELS, RUN_STATUS_LABELS } from "../constants/statuses";
import { URLS } from "../urls";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { Select } from "../components/Select";

const TABS = WORKFLOW_RUN_STATUSES;

/** Shared by every table cell. */
const CELL_CLASSES = "border-b border-line px-3.5 py-2.25 text-left";

/** How many runs the Start button can start at once. */
const RUN_COUNTS = [1, 5, 10, 25, 50];

export function RunsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestedStatus = params.get("status") as WorkflowRunStatus | null;
  const tab: WorkflowRunStatus | "all" =
    requestedStatus && TABS.includes(requestedStatus) ? requestedStatus : "all";
  const [cursors, setCursors] = useState<string[]>([]);
  const [workflowName, setWorkflowName] = useState<string | null>(null);
  const [presetIndex, setPresetIndex] = useState(0);
  const [runCount, setRunCount] = useState(1);
  const cursor = cursors.at(-1) ?? null;

  const { data, error } = useRuns({ status: tab, cursor });
  const { data: workflows } = useWorkflows();
  const workflow = workflows?.find((w) => w.name === workflowName) ?? workflows?.[0];
  const start = useStartRuns();

  function selectTab(next: WorkflowRunStatus | "all") {
    setCursors([]);
    navigate(URLS.runs.list({ status: next === "all" ? undefined : next }));
  }

  function startRuns() {
    if (!workflow) return;
    const input = workflow.presets[presetIndex]?.input ?? {};
    start.mutate(
      { workflow: workflow.name, input, count: runCount },
      {
        // One run opens its page. Several stay on the list, so they can be watched together.
        onSuccess: (runs) => {
          if (runs.length === 1) navigate(URLS.runs.details({ id: runs[0].id }));
          else selectTab("all");
        },
      },
    );
  }

  const totalRuns = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold">Workflow runs</h1>
        <form
          className="flex flex-wrap items-center gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            startRuns();
          }}
        >
          <label className="sr-only" htmlFor="workflow">
            Workflow
          </label>
          <Select
            id="workflow"
            value={workflow?.name ?? ""}
            onChange={(e) => {
              setWorkflowName(e.target.value);
              setPresetIndex(0);
            }}
          >
            {workflows?.map((w) => (
              <option key={w.name} value={w.name}>
                {w.title}
              </option>
            ))}
          </Select>
          {workflow && workflow.presets.length > 0 && (
            <>
              <label className="sr-only" htmlFor="preset">
                Input
              </label>
              <Select
                id="preset"
                value={presetIndex}
                onChange={(e) => setPresetIndex(Number(e.target.value))}
              >
                {workflow.presets.map((preset, i) => (
                  <option key={preset.label} value={i}>
                    {preset.label}
                  </option>
                ))}
              </Select>
            </>
          )}
          <label className="sr-only" htmlFor="run-count">
            How many runs
          </label>
          <Select
            id="run-count"
            value={runCount}
            onChange={(e) => setRunCount(Number(e.target.value))}
          >
            {RUN_COUNTS.map((n) => (
              <option key={n} value={n}>
                × {n}
              </option>
            ))}
          </Select>
          <Button variant="primary" type="submit" disabled={!workflow || start.isPending}>
            {start.isPending
              ? "Starting…"
              : runCount === 1
                ? "Start run"
                : `Start ${runCount} runs`}
          </Button>
        </form>
      </div>
      {start.error && (
        <ErrorMessage>
          Could not start {runCount === 1 ? "the run" : "every run"}: {start.error.message}
        </ErrorMessage>
      )}

      <div className="mt-5 mb-3 flex gap-1 overflow-x-auto" role="tablist">
        <Button
          variant="tab"
          role="tab"
          aria-selected={tab === "all"}
          onClick={() => selectTab("all")}
        >
          All <Count>{totalRuns}</Count>
        </Button>
        {TABS.map((t) => (
          <Button
            key={t}
            variant="tab"
            role="tab"
            aria-selected={tab === t}
            onClick={() => selectTab(t)}
          >
            {RUN_STATUS_LABELS[t]} <Count>{data?.counts[t] ?? 0}</Count>
          </Button>
        ))}
      </div>

      {error && <ErrorMessage>Could not reach the API: {error.message}</ErrorMessage>}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full whitespace-nowrap">
          <thead className="text-xs/normal text-muted [&_th]:font-medium">
            <tr>
              <th className={CELL_CLASSES}>Run</th>
              <th className={CELL_CLASSES}>Workflow</th>
              <th className={CELL_CLASSES}>Status</th>
              <th className={CELL_CLASSES}>Progress</th>
              <th className={CELL_CLASSES}>Created</th>
              <th className={CELL_CLASSES}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {data?.runs.map((run) => (
              <tr
                key={run.id}
                className="cursor-pointer hover:bg-grey-soft last:*:border-b-0"
                onClick={() => navigate(URLS.runs.details({ id: run.id }))}
              >
                <td className={CELL_CLASSES}>
                  <Link
                    className="font-mono text-[13px]"
                    to={URLS.runs.details({ id: run.id })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {run.id.slice(0, 8)}
                  </Link>
                </td>
                <td className={CELL_CLASSES}>{run.workflow_title}</td>
                <td className={CELL_CLASSES}>
                  <StatusBadge status={run.status} />
                  {run.failure_reason && (
                    <span className="ml-2 text-xs text-muted">
                      {FAILURE_REASON_LABELS[run.failure_reason]}
                    </span>
                  )}
                </td>
                <td className={`${CELL_CLASSES} font-mono text-[13px]`}>
                  {run.steps_done}/{run.steps_total}
                </td>
                <td className={CELL_CLASSES}>
                  <Age at={run.created_at} />
                </td>
                <td className={`${CELL_CLASSES} font-mono text-[13px]`}>
                  <Elapsed start={run.started_at} end={run.finished_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.runs.length === 0 && (
          <p className="p-8 text-center text-muted">
            No runs here yet. Choose a workflow and press Start run.
          </p>
        )}
      </div>

      {(cursors.length > 0 || data?.next_cursor) && (
        <div className="mt-3 flex justify-end gap-2">
          <Button disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
            Newer
          </Button>
          <Button
            disabled={!data?.next_cursor}
            onClick={() => data?.next_cursor && setCursors([...cursors, data.next_cursor])}
          >
            Older
          </Button>
        </div>
      )}
    </>
  );
}

/** The number next to each tab's label. */
function Count({ children }: { children: number }) {
  return <span className="ml-0.5 font-mono text-xs/normal text-muted">{children}</span>;
}
