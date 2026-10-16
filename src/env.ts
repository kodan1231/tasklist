import type { TaskStore } from "./store";

export interface Env {
  TASKS: DurableObjectNamespace<TaskStore>;
  ASSETS: Fetcher;
  // 最初のメンバー（メンバーが 0 人のときだけ使う）。"a@example.com=名前,b@example.com=名前" 形式
  USERS?: string;
  // Cloudflare Access のチームドメイン（例: myteam.cloudflareaccess.com）
  ACCESS_TEAM_DOMAIN?: string;
  // Cloudflare Access アプリケーションの AUD タグ
  ACCESS_AUD?: string;
  // ローカル開発（localhost）でのみ使う、ログイン中とみなすメールアドレス
  DEV_USER_EMAIL?: string;
}
