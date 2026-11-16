class Organization < ApplicationRecord
  has_many :teams, dependent: :destroy
  has_many :users, dependent: :destroy
  has_many :invoices, dependent: :destroy
  has_many :reports, dependent: :destroy

  validates :name, presence: true, uniqueness: true
end
