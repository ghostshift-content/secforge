class Role < ApplicationRecord
  has_many :users, dependent: :restrict_with_error

  enum role: { admin: 0, manager: 1, member: 2, auditor: 3 }

  validates :role, presence: true, uniqueness: true
end
