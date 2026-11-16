import type { ScheduleInfo } from "@ratchet/api/types";
import { usePauseSchedule } from "../hooks/mutations/usePauseSchedule";
import { useResumeSchedule } from "../hooks/mutations/useResumeSchedule";
import { Age } from "./Age";
import { Button } from "./Button";
import { ErrorMessage } from "./ErrorMessage";
import { Panel } from "./Panel";
import { Pill } from "./Pill";
import { Until } from "./Until";

/** Shared by every table cell. */
const CELL_CLASSES = "border-b border-line px-3.5 py-2.25 text-left";

/** The workflows' schedules and when each next fires, with a button to pause or resume each. */
export function SchedulesPanel({ schedules }: { schedules: ScheduleInfo[] }) {
  const pause = usePauseSchedule();
  const resume = useResumeSchedule();
  const busy = pause.isPending || resume.isPending;

  return (
    <Panel className="mt-5 overflow-x-auto p-0">
      <h2 className="px-3.5 pt-3 pb-1 font-semibold">Schedules</h2>
      <table className="w-full whitespace-nowrap">
        <thead className="text-xs/normal text-muted [&_th]:font-medium">
          <tr>
            <th className={CELL_CLASSES}>Workflow</th>
            <th className={CELL_CLASSES}>Schedule</th>
            <th className={CELL_CLASSES}>
              Cron <span className="font-normal">(UTC)</span>
            </th>
            <th className={CELL_CLASSES}>Next run</th>
            <th className={CELL_CLASSES}>Last run</th>
            <th className={CELL_CLASSES}></th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((schedule) => {
            const ref = { workflow: schedule.workflow, name: schedule.name };
            // A one-time schedule that has fired has no next run and nothing to pause.
            const done = schedule.cron === null && schedule.next_fire_at === null;
            return (
              <tr key={`${schedule.workflow}/${schedule.name}`} className="last:*:border-b-0">
                <td className={CELL_CLASSES}>{schedule.workflow_title}</td>
                <td className={CELL_CLASSES}>{schedule.name}</td>
                <td className={`${CELL_CLASSES} font-mono text-[13px]`}>
                  {schedule.cron ?? <span className="font-sans text-muted">once</span>}
                </td>
                <td className={CELL_CLASSES}>
                  {schedule.paused_at ? (
                    <Pill tone="amber">Paused</Pill>
                  ) : done ? (
                    <span className="text-muted">done</span>
                  ) : (
                    <Until at={schedule.next_fire_at} />
                  )}
                </td>
                <td className={CELL_CLASSES}>
                  <Age at={schedule.last_fired_at} />
                </td>
                <td className={`${CELL_CLASSES} text-right`}>
                  {schedule.paused_at ? (
                    <Button disabled={busy} onClick={() => resume.mutate(ref)}>
                      Resume
                    </Button>
                  ) : (
                    !done && (
                      <Button disabled={busy} onClick={() => pause.mutate(ref)}>
                        Pause
                      </Button>
                    )
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pause.error && (
        <ErrorMessage>Could not pause the schedule: {pause.error.message}</ErrorMessage>
      )}
      {resume.error && (
        <ErrorMessage>Could not resume the schedule: {resume.error.message}</ErrorMessage>
      )}
    </Panel>
  );
}
