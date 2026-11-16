class Receipt < ApplicationRecord
  belongs_to :expense

  enum ocr_status: { pending: 0, processed: 1, failed: 2 }

  validates :file_url, presence: true
end
