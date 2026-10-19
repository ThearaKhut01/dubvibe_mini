import { useI18n, useText } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { text, type TaskStatus, type TaskView } from '../sdk'

export const ACTIVE_STATUSES = new Set<TaskStatus>(['queued', 'running', 'waiting', 'cancelling'])
export const STATUS_LABELS: Record<string, [string, string, string?]> = {
  queued: ['Queued', 'Queued', 'ក្នុងជួររង់ចាំ'], running: ['Running', 'Running', 'កំពុងដំណើរការ'],
  waiting: ['Waiting', 'Waiting', 'រង់ចាំ'], cancelling: ['Cancelling', 'Cancelling', 'កំពុងបោះបង់'],
  cancelled: ['Cancelled', 'Cancelled', 'បានបោះបង់'], succeeded: ['Completed', 'Completed', 'ជោគជ័យ'], failed: ['Failed', 'Failed', 'បរាជ័យ'],
  pending: ['Pending', 'Pending', 'រង់ចាំដំណើរការ'], completed: ['Completed', 'Completed', 'បានបញ្ចប់'],
}

export function TaskState({ status }: { status: string }) {
  const tx = useText()
  return <span className={cn('shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium', status === 'failed' ? 'bg-status-danger/10 text-status-danger-fg' : status === 'succeeded' || status === 'completed' ? 'bg-status-success/10 text-status-success-fg' : 'bg-accent text-muted-foreground')}>{STATUS_LABELS[status] ? tx(...STATUS_LABELS[status]) : status}</span>
}

export function TaskProgress({ task }: { task: TaskView }) {
  const tx = useText()
  const { language } = useI18n()
  if (!ACTIVE_STATUSES.has(task.status)) return null
  const step = task.status === 'queued' ? undefined : task.steps.find((item) => item.status === 'running' || item.status === 'waiting')
  const completed = task.steps.filter((item) => item.status === 'completed').length
  const progress = task.status === 'running' && step?.status === 'running' ? step.progress : null
  const label = step ? text(step.label, language) : ''
  if (!step && !task.steps.length) return null
  return <div className="space-y-2 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      {step && <span className="min-w-0 break-words">{label}{progress != null ? ` · ${Math.round(progress * 100)}%` : ''}</span>}
      {task.steps.length > 0 && <span className="whitespace-nowrap">{tx(`${completed}/${task.steps.length} steps completed`, `已完成 ${completed}/${task.steps.length} 步`, `បានបញ្ចប់ជំហាន ${completed}/${task.steps.length}`)}</span>}
    </div>
    {progress != null && <progress aria-label={`${label} ${tx('progress', '进度', 'វឌ្ឍនភាព')}`} value={progress} max={1} className="block h-1.5 w-full accent-primary" />}
  </div>
}
