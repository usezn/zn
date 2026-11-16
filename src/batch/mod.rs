use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ai::Embedder;
use crate::metrics;
use anyhow::Result;
use crossbeam_channel::{bounded, Receiver, Sender};
use tokio::sync::Mutex;

/// Batch item to be processed
pub struct BatchItem {
    pub text: String,
    pub callback: Option<Box<dyn Fn(Vec<f32>) + Send + Sync>>,
}

impl BatchItem {
    pub fn new(text: String) -> Self {
        Self {
            text,
            callback: None,
        }
    }

    pub fn with_callback(mut self, callback: Box<dyn Fn(Vec<f32>) + Send + Sync>) -> Self {
        self.callback = Some(callback);
        self
    }
}

/// Batch processing configuration
#[derive(Debug, Clone)]
pub struct BatchConfig {
    pub batch_size: usize,
    pub max_buffer_size: usize,
    pub timeout_ms: u64,
    pub worker_count: usize,
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            batch_size: 32,
            max_buffer_size: 1000,
            timeout_ms: 100,
            worker_count: 4,
        }
    }
}

/// Batch processing pipeline
pub struct BatchPipeline {
    config: BatchConfig,
    buffer: Arc<Mutex<VecDeque<BatchItem>>>,
    sender: Sender<BatchItem>,
    receiver: Receiver<BatchItem>,
    embedder: Option<Arc<Embedder>>,
}

impl BatchPipeline {
    /// Create a new batch pipeline
    pub fn new(config: BatchConfig, embedder: Option<Arc<Embedder>>) -> Self {
        let (sender, receiver) = bounded(config.max_buffer_size);
        Self {
            config,
            buffer: Arc::new(Mutex::new(VecDeque::new())),
            sender,
            receiver,
            embedder,
        }
    }

    /// Submit an item to the batch queue
    pub async fn submit(&self, item: BatchItem) -> Result<()> {
        metrics::set_batch_queue_size(self.buffer.lock().await.len());
        self.sender.send(item)?;
        Ok(())
    }

    /// Get current buffer size
    pub async fn buffer_size(&self) -> usize {
        self.buffer.lock().await.len()
    }

    /// Process batch in background
    pub async fn process_batch(&self) -> Result<Vec<(String, Vec<f32>)>> {
        let start = Instant::now();
        let mut items: Vec<BatchItem> = Vec::new();
        let mut buffer = self.buffer.lock().await;

        while items.len() < self.config.batch_size && !buffer.is_empty() {
            if let Some(item) = buffer.pop_front() {
                items.push(item);
            } else {
                break;
            }
        }

        metrics::set_batch_queue_size(buffer.len());

        if items.is_empty() {
            return Ok(Vec::new());
        }

        drop(buffer);

        let results = if let Some(ref embedder) = self.embedder {
            let mut results = Vec::new();
            for item in &items {
                match embedder.embed(&item.text) {
                    Ok(embedding) => {
                        let embedding_clone = embedding.clone();
                        results.push((item.text.clone(), embedding));
                        if let Some(cb) = &item.callback {
                            cb(embedding_clone);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to embed text: {}", e);
                    }
                }
            }
            results
        } else {
            Vec::new()
        };

        let duration = start.elapsed();
        metrics::record_batch_duration(duration.as_secs_f64());
        metrics::record_batch_processed();

        Ok(results)
    }

    /// Start background worker
    pub fn start_worker(self: Arc<Self>) {
        let embedder = self.embedder.clone();
        let config = self.config.clone();
        let receiver = self.receiver.clone();

        tokio::spawn(async move {
            let mut last_process = Instant::now();
            let mut batch_buffer: Vec<BatchItem> = Vec::new();

            loop {
                let buffer_size = batch_buffer.len();

                if (buffer_size >= config.batch_size
                    || (buffer_size > 0
                        && last_process.elapsed() >= Duration::from_millis(config.timeout_ms)))
                    && !batch_buffer.is_empty()
                {
                    let items = std::mem::take(&mut batch_buffer);
                    let pipeline = BatchPipeline::new(config.clone(), embedder.clone());
                    if let Ok(results) = pipeline.process_batch_with_items(items).await {
                        for (text, embedding) in results {
                            tracing::info!("Batch processed: {} -> {} dims", text, embedding.len());
                        }
                    }
                    last_process = Instant::now();
                }

                match receiver.try_recv() {
                    Ok(item) => {
                        batch_buffer.push(item);
                    }
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
        });
    }

    /// Process batch with provided items (for testing)
    pub async fn process_batch_with_items(
        &self,
        items: Vec<BatchItem>,
    ) -> Result<Vec<(String, Vec<f32>)>> {
        let start = Instant::now();

        if items.is_empty() {
            return Ok(Vec::new());
        }

        let results = if let Some(ref embedder) = self.embedder {
            let mut results = Vec::new();
            for item in &items {
                match embedder.embed(&item.text) {
                    Ok(embedding) => {
                        let embedding_clone = embedding.clone();
                        results.push((item.text.clone(), embedding));
                        if let Some(cb) = &item.callback {
                            cb(embedding_clone);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to embed text: {}", e);
                    }
                }
            }
            results
        } else {
            Vec::new()
        };

        let duration = start.elapsed();
        metrics::record_batch_duration(duration.as_secs_f64());
        metrics::record_batch_processed();

        Ok(results)
    }
}

/// Batch buffer manager
pub struct BatchBuffer {
    items: VecDeque<BatchItem>,
    max_size: usize,
    total_processed: usize,
    total_dropped: usize,
}

impl BatchBuffer {
    /// Create a new batch buffer
    pub fn new(max_size: usize) -> Self {
        Self {
            items: VecDeque::new(),
            max_size,
            total_processed: 0,
            total_dropped: 0,
        }
    }

    /// Add item to buffer
    pub fn push(&mut self, item: BatchItem) -> bool {
        if self.items.len() >= self.max_size {
            self.total_dropped += 1;
            metrics::record_cache_eviction();
            return false;
        }
        self.items.push_back(item);
        true
    }

    /// Pop item from buffer
    pub fn pop(&mut self) -> Option<BatchItem> {
        let item = self.items.pop_front();
        if item.is_some() {
            self.total_processed += 1;
        }
        item
    }

    /// Get current size
    pub fn size(&self) -> usize {
        self.items.len()
    }

    /// Get stats
    pub fn stats(&self) -> BatchBufferStats {
        BatchBufferStats {
            size: self.items.len(),
            max_size: self.max_size,
            total_processed: self.total_processed,
            total_dropped: self.total_dropped,
        }
    }
}

/// Batch buffer statistics
#[derive(Debug, Clone)]
pub struct BatchBufferStats {
    pub size: usize,
    pub max_size: usize,
    pub total_processed: usize,
    pub total_dropped: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_batch_pipeline_submit() {
        let config = BatchConfig::default();
        let pipeline = BatchPipeline::new(config, None);

        let item = BatchItem::new("test text".to_string());
        let result = pipeline.submit(item).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_batch_buffer_push_pop() {
        let mut buffer = BatchBuffer::new(10);

        let item = BatchItem::new("test".to_string());
        assert!(buffer.push(item));
        assert_eq!(buffer.size(), 1);

        let popped = buffer.pop();
        assert!(popped.is_some());
        assert_eq!(buffer.size(), 0);
    }

    #[tokio::test]
    async fn test_batch_buffer_overflow() {
        let mut buffer = BatchBuffer::new(2);

        assert!(buffer.push(BatchItem::new("1".to_string())));
        assert!(buffer.push(BatchItem::new("2".to_string())));
        assert!(!buffer.push(BatchItem::new("3".to_string())));

        let stats = buffer.stats();
        assert_eq!(stats.total_dropped, 1);
        assert_eq!(stats.total_processed, 0);
    }

    #[tokio::test]
    async fn test_batch_buffer_stats() {
        let mut buffer = BatchBuffer::new(10);

        buffer.push(BatchItem::new("1".to_string()));
        buffer.push(BatchItem::new("2".to_string()));
        buffer.pop();

        let stats = buffer.stats();
        assert_eq!(stats.size, 1);
        assert_eq!(stats.max_size, 10);
        assert_eq!(stats.total_processed, 1);
        assert_eq!(stats.total_dropped, 0);
    }

    #[tokio::test]
    async fn test_batch_pipeline_with_embedder() {
        let dir = std::env::temp_dir().join("zn-phaseF-batch-test");
        let _ = std::fs::remove_dir_all(&dir);
        let embedder = Embedder::with_cache(&dir, 300).expect("model must load");
        let embedder = Arc::new(embedder);

        let config = BatchConfig {
            batch_size: 2,
            max_buffer_size: 100,
            timeout_ms: 1000,
            worker_count: 1,
        };

        let pipeline = BatchPipeline::new(config, Some(embedder));
        let _ = pipeline
            .process_batch_with_items(vec![
                BatchItem::new("test text 1".to_string()),
                BatchItem::new("test text 2".to_string()),
            ])
            .await;

        let results = pipeline
            .process_batch_with_items(vec![
                BatchItem::new("test text 1".to_string()),
                BatchItem::new("test text 2".to_string()),
            ])
            .await;

        assert!(results.is_ok());
        let results = results.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].1.len(), 384);
    }

    #[tokio::test]
    async fn test_batch_item_with_callback_sets_callback() {
        let item = BatchItem::new("x".to_string()).with_callback(Box::new(|_| {}));
        assert!(item.callback.is_some());
        assert!(BatchItem::new("y".to_string()).callback.is_none());
    }

    #[test]
    fn test_batch_config_default_values() {
        let c = BatchConfig::default();
        assert_eq!(c.batch_size, 32);
        assert_eq!(c.max_buffer_size, 1000);
        assert_eq!(c.timeout_ms, 100);
        assert_eq!(c.worker_count, 4);
    }

    #[tokio::test]
    async fn test_process_batch_empty_buffer_returns_empty() {
        let pipeline = BatchPipeline::new(BatchConfig::default(), None);
        let results = pipeline.process_batch().await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_process_batch_drains_up_to_batch_size_without_embedder() {
        let config = BatchConfig {
            batch_size: 2,
            ..BatchConfig::default()
        };
        let pipeline = BatchPipeline::new(config, None);
        {
            let mut buf = pipeline.buffer.lock().await;
            for t in ["a", "b", "c"] {
                buf.push_back(BatchItem::new(t.to_string()));
            }
        }
        assert_eq!(pipeline.buffer_size().await, 3);
        // No embedder: items are consumed but nothing is embedded.
        let results = pipeline.process_batch().await.unwrap();
        assert!(results.is_empty());
        assert_eq!(pipeline.buffer_size().await, 1);
        pipeline.process_batch().await.unwrap();
        assert_eq!(pipeline.buffer_size().await, 0);
    }

    #[tokio::test]
    async fn test_process_batch_with_items_empty_and_no_embedder() {
        let pipeline = BatchPipeline::new(BatchConfig::default(), None);
        assert!(pipeline
            .process_batch_with_items(Vec::new())
            .await
            .unwrap()
            .is_empty());
        let fired = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let f = fired.clone();
        let item = BatchItem::new("hello".to_string()).with_callback(Box::new(move |_| {
            f.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        let results = pipeline.process_batch_with_items(vec![item]).await.unwrap();
        assert!(results.is_empty());
        assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn test_submit_queues_item_in_channel() {
        let config = BatchConfig {
            max_buffer_size: 1,
            ..BatchConfig::default()
        };
        let pipeline = BatchPipeline::new(config, None);
        pipeline
            .submit(BatchItem::new("1".to_string()))
            .await
            .unwrap();
        // Items sit in the channel until a worker moves them to the buffer.
        assert_eq!(pipeline.buffer_size().await, 0);
        assert_eq!(pipeline.receiver.len(), 1);
    }

    #[tokio::test]
    async fn test_start_worker_drains_the_channel() {
        let config = BatchConfig {
            batch_size: 2,
            max_buffer_size: 10,
            timeout_ms: 20,
            worker_count: 1,
        };
        let pipeline = Arc::new(BatchPipeline::new(config, None));
        for t in ["a", "b", "c"] {
            pipeline
                .submit(BatchItem::new(t.to_string()))
                .await
                .unwrap();
        }
        pipeline.clone().start_worker();
        for _ in 0..200 {
            if pipeline.receiver.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(pipeline.receiver.is_empty(), "worker consumed all items");
        // Let the timeout flush the final partial batch.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
