ALTER TABLE `marketplace_purchases`
  ADD COLUMN `workflow_version_id` int DEFAULT NULL,
  ADD COLUMN `evidence_publication_id` int DEFAULT NULL,
  ADD CONSTRAINT `fk_purchase_workflow_version`
    FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `fk_purchase_evidence_publication`
    FOREIGN KEY (`evidence_publication_id`) REFERENCES `evidence_publications` (`id`) ON DELETE RESTRICT;
