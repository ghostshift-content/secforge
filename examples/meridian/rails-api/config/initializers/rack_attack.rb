class Rack::Attack
  throttle("requests by ip", limit: 300, period: 5.minutes) do |req|
    req.ip
  end

  throttle("writes by ip", limit: 60, period: 1.minute) do |req|
    req.ip if req.post? || req.put? || req.patch? || req.delete?
  end

  throttle("logins by ip", limit: 5, period: 20.seconds) do |req|
    req.ip if req.path == "/login" && req.post?
  end

  self.throttled_responder = lambda do |_request|
    [429, { "Content-Type" => "application/json" }, [{ error: "Rate limit exceeded" }.to_json]]
  end
end
