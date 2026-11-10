import styles from "./site.module.css";

export default function NotFound() {
  return <main className={styles.page}><div className={styles.content}>
    <h1>There’s no page here.</h1>
    <p>This address may not exist, or its owner may not have published a page.</p>
  </div></main>;
}
