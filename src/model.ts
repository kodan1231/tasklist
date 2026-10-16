// 担当者が「全員（メンバー全員）」であることを表す値
export const ALL = "*";

export const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

export interface Member {
  email: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  title: string;
  due: string | null; // YYYY-MM-DD
  assignee: string; // メンバーのメールアドレス、または ALL
  tags: string[]; // タグ ID
  completedBy: string[]; // 自分の分を完了したメンバー
  done: boolean; // 担当者全員が完了したか
  createdAt: number;
}

export interface TaskInput {
  title: string;
  due: string | null;
  assignee: string;
  tags: string[];
}

export type TaskPatch = Partial<TaskInput> & { done?: boolean };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
