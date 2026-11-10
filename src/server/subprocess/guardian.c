#define _GNU_SOURCE
/* Linux lifetime boundary. Compile with cc -O2 -Wall -Wextra -Werror.
 * Never install setuid. All descendants must run with this guardian's uid.
 * The owner PID is checked after installing PDEATHSIG, closing the exec race.
 * SIGTERM requests cleanup; SIGKILL of this guardian cannot provide a join.
 */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long long millis(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(125);
  return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static long number(const char *s) {
  char *end;
  errno = 0;
  long n = strtol(s, &end, 10);
  if (errno || !*s || *end || n <= 0 || n > INT_MAX) _exit(125);
  return n;
}

/* Only enumerate our OWN unreaped children, never an arbitrary /proc tree.
 * SIGCHLD is blocked and no wait happens between reading and signalling them:
 * these PIDs cannot be reused until we reap them. Subreaper adoption exposes
 * escaped groups after their ancestors die. Repeat until waitpid says ECHILD.
 */
static void kill_owned_children(void) {
  char name[96];
  snprintf(name, sizeof(name), "/proc/self/task/%ld/children", (long)getpid());
  FILE *f = fopen(name, "re");
  if (!f) _exit(125); /* procfs is a required runtime dependency */
  long pid;
  while (fscanf(f, "%ld", &pid) == 1) {
    if (pid > 1 && pid <= INT_MAX) {
      /* A nested guardian must retain its lock until its own ECHILD barrier.
       * It has its own group and handles TERM even after subreaper adoption.
       * Own, unreaped child identity cannot change to a recycled PID here.
       */
      char exe[96];
      struct stat own, descendant;
      snprintf(exe, sizeof(exe), "/proc/%ld/exe", pid);
      int guardian = !stat("/proc/self/exe", &own) && !stat(exe, &descendant) &&
        own.st_dev == descendant.st_dev && own.st_ino == descendant.st_ino;
      kill((pid_t)pid, guardian ? SIGTERM : SIGKILL);
    }
  }
  fclose(f);
}

static int events(int fd, int timeout) {
  struct pollfd p = { .fd = fd, .events = POLLIN };
  int r = poll(&p, 1, timeout);
  if (r < 0 && errno != EINTR) _exit(125);
  int stop = 0;
  struct signalfd_siginfo info;
  while (read(fd, &info, sizeof(info)) == sizeof(info)) {
    if (info.ssi_signo != SIGCHLD) stop = 1;
  }
  return stop;
}

int main(int argc, char **argv) {
  /* guardian owner-pid timeout-ms ipc-fd-or-0 lock-file-or-empty version -- command ... */
  if (argc < 8 || argv[6][0] != '-' || argv[6][1] != '-' || argv[6][2]) return 125;
  pid_t owner = (pid_t)number(argv[1]);
  long timeout = number(argv[2]);
  int ipc = argv[3][0] == '0' && !argv[3][1] ? 0 : (int)number(argv[3]);
  long long deadline = millis() + timeout;
  sigset_t mask;
  sigemptyset(&mask);
  sigaddset(&mask, SIGCHLD); sigaddset(&mask, SIGTERM);
  sigaddset(&mask, SIGINT); sigaddset(&mask, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &mask, NULL) ||
      prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGTERM)) return 125;
  if (getppid() != owner) return 125;
  /* Stay outside every payload group, including our parent's payload group. */
  if (setpgid(0, 0) && errno != EACCES) return 125;
  int signals = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
  if (signals < 0) return 125;
  /* Check procfs before starting any work. */
  kill_owned_children();
  int lock = -1;
  if (*argv[4]) {
    lock = open(argv[4], O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    struct stat st;
    if (lock < 0 || fstat(lock, &st) || !S_ISREG(st.st_mode) ||
        st.st_uid != geteuid() || (st.st_mode & 077)) return 125;
    for (;;) {
      if (!flock(lock, LOCK_EX | LOCK_NB)) break;
      if (errno != EWOULDBLOCK && errno != EAGAIN) return 125;
      if (events(signals, 10)) return 125;
      if (millis() >= deadline) return 124;
    }
  }
  /* argv[5] is reserved for future versioning; refuse incompatible callers. */
  if (argv[5][0] != '1' || argv[5][1]) return 125;
  if (getppid() != owner || events(signals, 0)) return 125;
  pid_t guardian = getpid(), child = fork();
  if (child < 0) return 125;
  if (!child) {
    if (setpgid(0, 0) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != guardian) _exit(125);
    close(signals);
    if (lock >= 0) close(lock);
    sigset_t empty;
    sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL)) _exit(125);
    execvp(argv[7], &argv[7]);
    _exit(errno == ENOENT ? 127 : 126);
  }
  /* Also establish the group in the parent, so cancellation cannot race exec. */
  if (setpgid(child, child) && errno != EACCES && errno != ESRCH) kill(child, SIGKILL);
  if (ipc) close(ipc); /* IPC belongs only to the Node payload. */
  close(STDIN_FILENO); /* payload alone owns the caller's input pipe */
  int stopping = 0, result = 125, child_done = 0;
  for (;;) {
    if (!stopping && millis() >= deadline) { stopping = 1; result = 124; }
    if (stopping) {
      /* group kill is fast; adoption handles descendants that made new groups. */
      if (!child_done) kill(-child, SIGKILL);
      kill_owned_children();
    }
    int status;
    pid_t reaped;
    while ((reaped = waitpid(-1, &status, WNOHANG)) > 0) {
      if (reaped == child) {
        child_done = 1;
        if (!stopping) result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        stopping = 1; /* successful payloads must not leave background work */
      }
    }
    if (reaped < 0 && errno == ECHILD) break;
    if (reaped < 0 && errno != EINTR) return 125;
    long long remaining = deadline - millis();
    int delay = stopping ? 10 : remaining > INT_MAX ? INT_MAX : remaining > 0 ? (int)remaining : 0;
    if (events(signals, delay) && !stopping) { stopping = 1; result = 125; }
  }
  /* Closing the lock only after ECHILD makes completion a reaping barrier. */
  return result;
}
