class SessionsController < ApplicationController
  skip_before_action :authenticate_user!, only: [:create]

  def create
    user = User.find_by(email: params[:email].to_s.downcase)

    if user&.valid_password?(params[:password])
      sign_in(user)
      render json: { id: user.id, email: user.email, name: user.name }, status: :ok
    else
      render json: { error: "Invalid email or password" }, status: :unauthorized
    end
  end

  def destroy
    sign_out(current_user)
    head :no_content
  end
end
