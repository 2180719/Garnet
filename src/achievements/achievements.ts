import type { Db } from '../store/index.ts';

/** Facts achievements are judged on. Gathered by the composition root. */
export type Stats = {
  tasksCompleted: number;
  toolCalls: number;
  agentSkills: number;
  memoryChars: number;
  channelsPaired: number;
  approvalsDecided: number;
  jobRuns: number;
  quietHeartbeats: number;
  uptimeDays: number;
  lateNightTasks: number;
  compactions: number;
  apiKeys: number;
};

export type Achievement = {
  id: string;
  title: string;
  description: string;
  /** Hidden achievements show as "???" until unlocked. */
  hidden?: boolean;
  /** Easter eggs the dashboard may unlock directly (they grant nothing). */
  clientUnlock?: boolean;
  earned?: (s: Stats) => boolean;
};

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'hello-garnet', title: 'Hello, Garnet', description: 'Complete your first task.', earned: (s) => s.tasksCompleted >= 1 },
  { id: 'regular', title: 'Regular', description: 'Complete 100 tasks.', earned: (s) => s.tasksCompleted >= 100 },
  { id: 'old-friends', title: 'Old Friends', description: 'Complete 1,000 tasks.', earned: (s) => s.tasksCompleted >= 1000 },
  { id: 'hands-on', title: 'Hands On', description: 'Garnet used 100 tools.', earned: (s) => s.toolCalls >= 100 },
  { id: 'learned-something', title: 'Learned Something', description: 'Garnet wrote its first skill.', earned: (s) => s.agentSkills >= 1 },
  { id: 'well-read', title: 'Well Read', description: 'Garnet knows ten skills of its own.', earned: (s) => s.agentSkills >= 10 },
  { id: 'remembers-you', title: 'Remembers You', description: 'Garnet saved its first memory.', earned: (s) => s.memoryChars > 0 },
  { id: 'connected', title: 'Connected', description: 'Pair a chat with Garnet.', earned: (s) => s.channelsPaired >= 1 },
  { id: 'everywhere', title: 'Everywhere at Once', description: 'Pair three chats.', earned: (s) => s.channelsPaired >= 3 },
  { id: 'trust-but-verify', title: 'Trust, but Verify', description: 'Decide ten approval requests.', earned: (s) => s.approvalsDecided >= 10 },
  { id: 'clockwork', title: 'Clockwork', description: 'Scheduled jobs ran 50 times.', earned: (s) => s.jobRuns >= 50 },
  { id: 'all-quiet', title: 'All Quiet', description: 'A heartbeat found nothing worth bothering you about.', earned: (s) => s.quietHeartbeats >= 1 },
  { id: 'week-one', title: 'Week One', description: 'Garnet has been with you for a week.', earned: (s) => s.uptimeDays >= 7 },
  { id: 'a-year', title: 'Anniversary', description: 'One year together.', earned: (s) => s.uptimeDays >= 365 },
  { id: 'night-owl', title: 'Night Owl', description: 'Finish a task between 2 and 4 a.m.', hidden: true, earned: (s) => s.lateNightTasks >= 1 },
  { id: 'tidy-mind', title: 'Tidy Mind', description: 'Garnet summarized a long conversation to save tokens.', earned: (s) => s.compactions >= 1 },
  { id: 'open-door', title: 'Open Door', description: 'Create an API key.', earned: (s) => s.apiKeys >= 1 },
  { id: 'konami', title: '↑↑↓↓←→←→BA', description: 'You know the code.', hidden: true, clientUnlock: true },
  { id: 'gem-polisher', title: 'Gem Polisher', description: 'Click the garnet seven times.', hidden: true, clientUnlock: true },
  { id: 'sparkle', title: 'Sparkle', description: 'Ran `garnet --sparkle`.', hidden: true, clientUnlock: true },
];

export type AchievementView = { id: string; title: string; description: string; unlockedAt: string | null; hidden: boolean };

/** Persists unlocks. Unlocks are permanent and local; nothing is sent anywhere. */
export class Achievements {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Unlocks every newly earned achievement and returns the full list for display. */
  evaluate(stats: Stats, now = new Date()): AchievementView[] {
    for (const a of ACHIEVEMENTS) if (a.earned?.(stats)) this.unlock(a.id, now);
    return this.list();
  }

  unlock(id: string, now = new Date()): boolean {
    if (!ACHIEVEMENTS.some((a) => a.id === id)) return false;
    return this.db.prepare('INSERT OR IGNORE INTO achievements (id, unlocked_at) VALUES (?, ?)').run(id, now.toISOString()).changes > 0;
  }

  /** For easter eggs only: refuses achievements that must be earned. */
  unlockEasterEgg(id: string): boolean {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    return a?.clientUnlock ? this.unlock(id) : false;
  }

  list(): AchievementView[] {
    const rows = this.db.prepare('SELECT id, unlocked_at FROM achievements').all() as { id: string; unlocked_at: string }[];
    const unlocked = new Map(rows.map((r) => [r.id, r.unlocked_at]));
    return ACHIEVEMENTS.map((a) => {
      const at = unlocked.get(a.id) ?? null;
      const secret = a.hidden && !at;
      return { id: a.id, title: secret ? '???' : a.title, description: secret ? 'A secret. Keep exploring.' : a.description, unlockedAt: at, hidden: !!a.hidden };
    });
  }
}
