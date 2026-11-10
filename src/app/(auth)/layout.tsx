import type { ReactNode } from "react";
import styles from "./auth.module.css";
export const dynamic = "force-dynamic";
export default function AuthLayout({ children }: { children: ReactNode }) { return <main className={styles.account}>{children}</main>; }
