export type Theme = "light" | "dark";

export interface User {
  id: string;
  name: string;
  email: string;
  theme: Theme;
}

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export interface Session {
  user: User | null;
  csrfToken: string;
}
