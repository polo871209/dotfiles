use crate::cache::{self, Freshness};
use gix::bstr::ByteSlice;
use gix::remote::Direction;
use gix::status::Submodule;
use std::path::Path;

#[derive(Debug, PartialEq)]
pub enum Head {
    Branch(String),
    Detached(String),
}

#[derive(Debug, Default, PartialEq)]
pub struct Changes {
    pub dirty: bool,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, PartialEq)]
pub struct Status {
    pub head: Head,
    pub changes: Changes,
}

pub fn status(cwd: &Path, freshness: Freshness) -> Option<Status> {
    let repo = gix::discover_with_environment_overrides(cwd).ok()?;
    let head = repo.head().ok()?;
    let local = head.id().map(|id| id.detach());
    let branch = head.referent_name().map(|name| name.to_owned());
    let head = match (&branch, local) {
        (Some(name), _) => Head::Branch(name.shorten().to_str_lossy().into_owned()),
        (None, Some(id)) => Head::Detached(id.to_hex_with_len(7).to_string()),
        (None, None) => return None,
    };
    let head_key = match &head {
        Head::Branch(name) => format!("branch {name}"),
        Head::Detached(commit) => format!("detached {commit}"),
    };
    let file = cache::file("git", repo.workdir().unwrap_or(repo.git_dir()));
    let changes = match freshness {
        Freshness::Cached => cached_changes(&cache::read(&file), &head_key).unwrap_or_default(),
        Freshness::Fresh => {
            let (ahead, behind) = branch.zip(local).and_then(|(name, local)| upstream_counts(&repo, &name, local)).unwrap_or_default();
            let changes = Changes { dirty: has_changes(&repo), ahead, behind };
            cache::write(&file, &format!("{head_key}\n{} {} {}", u8::from(changes.dirty), changes.ahead, changes.behind));
            changes
        }
    };
    Some(Status { head, changes })
}

fn cached_changes(text: &str, head_key: &str) -> Option<Changes> {
    let (key, values) = text.split_once('\n')?;
    if key != head_key {
        return None;
    }
    let mut values = values.split(' ').map(str::parse::<usize>);
    Some(Changes { dirty: values.next()?.ok()? != 0, ahead: values.next()?.ok()?, behind: values.next()?.ok()? })
}

fn upstream_counts(repo: &gix::Repository, branch: &gix::refs::FullName, local: gix::ObjectId) -> Option<(usize, usize)> {
    let upstream = repo.branch_remote_tracking_ref_name(branch.as_ref(), Direction::Fetch)?.ok()?;
    let upstream = repo.find_reference(upstream.as_ref()).ok()?.into_fully_peeled_id().ok()?.detach();
    Some((only_in(repo, local, upstream), only_in(repo, upstream, local)))
}

fn only_in(repo: &gix::Repository, tip: gix::ObjectId, other: gix::ObjectId) -> usize {
    if tip == other {
        return 0;
    }
    repo.rev_walk([tip]).with_hidden([other]).all().map_or(0, |walk| walk.filter_map(Result::ok).count())
}

fn has_changes(repo: &gix::Repository) -> bool {
    let Ok(status) = repo.status(gix::progress::Discard) else { return false };
    status
        .index_worktree_rewrites(None)
        .index_worktree_submodules(Submodule::AsConfigured { check_dirty: true })
        .into_iter(None)
        .ok()
        .and_then(|mut changes| changes.next())
        .is_some_and(|change| change.is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    struct Repo(PathBuf, std::cell::Cell<u32>);

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("zprompt-git-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Self(dir, std::cell::Cell::new(0));
            repo.git(&["init", "-q", "-b", "main"]);
            repo
        }

        fn git(&self, args: &[&str]) {
            let status = Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(&self.0)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        }

        fn commit(&self) {
            self.1.set(self.1.get() + 1);
            self.git(&["commit", "-q", "--allow-empty", "-m", &self.1.get().to_string()]);
        }

        fn status(&self) -> Option<Status> {
            status(&self.0, Freshness::Fresh)
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn branch(name: &str, dirty: bool, ahead: usize, behind: usize) -> Option<Status> {
        Some(Status { head: Head::Branch(name.into()), changes: Changes { dirty, ahead, behind } })
    }

    #[test]
    fn shows_branch_of_repository_without_commits() {
        let repo = Repo::new("unborn");
        assert_eq!(repo.status(), branch("main", false, 0, 0));
    }

    #[test]
    fn marks_untracked_staged_and_modified_files_as_changes() {
        let repo = Repo::new("dirty");
        repo.commit();
        assert_eq!(repo.status(), branch("main", false, 0, 0));
        std::fs::write(repo.0.join("file"), "a").unwrap();
        assert_eq!(repo.status(), branch("main", true, 0, 0));
        repo.git(&["add", "file"]);
        assert_eq!(repo.status(), branch("main", true, 0, 0));
        repo.git(&["commit", "-q", "-m", "file"]);
        assert_eq!(repo.status(), branch("main", false, 0, 0));
        std::fs::write(repo.0.join("file"), "b").unwrap();
        assert_eq!(repo.status(), branch("main", true, 0, 0));
    }

    #[test]
    fn ignores_ignored_files() {
        let repo = Repo::new("ignored");
        std::fs::write(repo.0.join(".gitignore"), "target\n").unwrap();
        repo.git(&["add", ".gitignore"]);
        repo.commit();
        std::fs::create_dir(repo.0.join("target")).unwrap();
        std::fs::write(repo.0.join("target/out"), "x").unwrap();
        assert_eq!(repo.status(), branch("main", false, 0, 0));
    }

    #[test]
    fn shows_short_commit_when_detached() {
        let repo = Repo::new("detached");
        repo.commit();
        repo.git(&["checkout", "-q", "--detach"]);
        let Some(Status { head: Head::Detached(commit), .. }) = repo.status() else { panic!() };
        assert_eq!(commit.len(), 7);
    }

    #[test]
    fn counts_commits_ahead_and_behind_upstream() {
        let repo = Repo::new("upstream");
        repo.commit();
        repo.git(&["branch", "base"]);
        repo.commit();
        repo.git(&["update-ref", "refs/remotes/origin/main", "base"]);
        repo.git(&["config", "branch.main.remote", "origin"]);
        repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
        repo.git(&["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        assert_eq!(repo.status(), branch("main", false, 1, 0));
        repo.git(&["reset", "-q", "--hard", "base"]);
        repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD@{1}"]);
        repo.commit();
        repo.commit();
        assert_eq!(repo.status(), branch("main", false, 2, 1));
    }

    #[test]
    fn cached_render_reuses_changes_only_for_the_same_head() {
        let repo = Repo::new("cached");
        repo.commit();
        std::fs::write(repo.0.join("file"), "a").unwrap();
        assert_eq!(repo.status(), branch("main", true, 0, 0));
        assert_eq!(status(&repo.0, Freshness::Cached), branch("main", true, 0, 0));
        repo.git(&["switch", "-q", "-c", "other"]);
        assert_eq!(status(&repo.0, Freshness::Cached), branch("other", false, 0, 0));
    }

    #[test]
    fn returns_nothing_outside_a_repository() {
        let dir = std::env::temp_dir().join(format!("zprompt-git-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(status(&dir, Freshness::Fresh), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
