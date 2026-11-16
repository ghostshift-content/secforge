Rails.application.routes.draw do
  post "/login", to: "sessions#create"
  delete "/logout", to: "sessions#destroy"

  resources :users, only: [:index, :show, :update]

  resources :teams, only: [:index, :show, :create, :update]

  resources :expenses do
    member do
      get :download_receipt
      post :submit
    end
    resources :approvals, only: [:create, :index]
  end

  resources :approvals, only: [:show, :update]

  resources :reimbursements, only: [:index, :show, :create]
  resources :invoices, only: [:index, :show, :create, :update]
  resources :reports, only: [:index, :show, :create]

  post "/webhooks/receipt_ocr", to: "webhooks/receipt_ocr#create"
end
