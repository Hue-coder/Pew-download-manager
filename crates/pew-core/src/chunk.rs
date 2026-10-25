use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub id: usize,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
}

impl Chunk {
    pub fn new(id: usize, start: u64, end: u64) -> Self {
        Self {
            id,
            start,
            end,
            downloaded: 0,
        }
    }

    pub fn total_bytes(&self) -> u64 {
        if self.end >= self.start {
            self.end - self.start + 1
        } else {
            0
        }
    }

    pub fn is_complete(&self) -> bool {
        self.downloaded >= self.total_bytes()
    }

    pub fn current_offset(&self) -> u64 {
        self.start + self.downloaded
    }
}

pub fn calculate_chunks(total_size: u64, parts: usize) -> Vec<Chunk> {
    if parts <= 1 || total_size < (parts as u64) {
        return vec![Chunk::new(0, 0, total_size.saturating_sub(1))];
    }

    let chunk_size = total_size / (parts as u64);
    let mut chunks = Vec::with_capacity(parts);

    for i in 0..parts {
        let start = (i as u64) * chunk_size;
        let end = if i == parts - 1 {
            total_size - 1
        } else {
            start + chunk_size - 1
        };

        chunks.push(Chunk::new(i, start, end));
    }

    chunks
}
