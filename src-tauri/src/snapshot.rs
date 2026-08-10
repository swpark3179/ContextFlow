//! Context snapshots — the whole point of the app.
//!
//! Written to `.context_snapshot.json` inside the task folder (dot-prefixed so
//! Obsidian and our own file tree both ignore it) whenever the user switches
//! tasks or puts one on hold, and read back when they return.

use crate::error::Result;
use serde_json::Value;
use std::fs;
use std::path::Path;

use crate::vault::SNAPSHOT_FILE;

pub fn load(folder: &Path) -> Result<Option<Value>> {
    let path = folder.join(SNAPSHOT_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)?;
    // A corrupt snapshot must never block opening the task.
    Ok(serde_json::from_str(&text).ok())
}

pub fn save(folder: &Path, value: &Value) -> Result<()> {
    if !folder.is_dir() {
        // The task folder was deleted or moved out from under us.
        return Ok(());
    }
    let path = folder.join(SNAPSHOT_FILE);
    fs::write(&path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}
